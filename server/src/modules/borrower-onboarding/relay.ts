import {
  ApplicantFury,
  ApplicantScope,
  applicantScope,
  isApplicantReferral,
  normalizeApplicantPhone,
  rejectApplicant as rejected,
} from '../applicant-session/fury';
import { ApplicantRedis, ApplicantSessions, newApplicantHandle } from '../applicant-session/store';
import { maxApplicantDocumentBytes } from '../applicant-session/upload';

export const BORROWER_ONBOARDING_ENV = 'TOOLJET_BORROWER_ONBOARDING';

const keyPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const nodePattern = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
const documentCode = /^[A-Za-z0-9_-]{1,64}$/;
const guestLifetime = 600;
const documents = {
  borrowerReferralEligibility: `mutation BorrowerEligibility($referral_token: String!) {
    borrowerReferralEligibility(referral_token: $referral_token) { organizationId productId }
  }`,
  applicationCreateFromReferral: `mutation BorrowerOpen($referral_token: String!) {
    applicationCreateFromReferral(referral_token: $referral_token) { id product_id }
  }`,
  applicationFlow: `query BorrowerFlow($application_id: Int!) {
    applicationFlow(application_id: $application_id) {
      productId
      steps { nodeId stepType status label formFields allowedKinds documentRequirements { type provider required status } }
      documentRequest { stepId reason requiredDocuments }
    }
  }`,
  executeFlowStep: `mutation BorrowerStep($application_id: Int!, $type: DocumentStepType!, $kind: DocumentStepKind!, $data: JSON) {
    executeFlowStep(application_id: $application_id, type: $type, kind: $kind, data: $data) {
      __typename
      ... on FlowStepPending { redirectUrl }
    }
  }`,
};

const controls = {
  kyc_pan: { type: 'KYC', kind: 'PAN', label: 'Save PAN' },
  document_collection: {
    type: 'KYC',
    kind: 'DIGILOCKER',
    label: 'Verify identity with DigiLocker',
  },
  bank_statement: {
    type: 'BANK_STATEMENT',
    kind: 'AA',
    label: 'Give bank-statement consent',
  },
  form: { type: 'FORM', kind: 'FORM', label: 'Save details' },
  agreement: { type: 'AGREEMENT', kind: 'DIGIO', label: 'Review agreement' },
} as const;
const browserSteps = new Set(['kyc_aadhaar', ...Object.keys(controls)]);
const fieldTypes = ['text', 'textarea', 'email', 'phone', 'money', 'integer', 'date', 'select', 'boolean'];

type Config = ApplicantScope & {
  returnUrl: string;
  providerOrigins: string[];
};
type RecordValue = Record<string, unknown>;
type SetCookie = (id: string, seconds: number) => void;
type State = {
  referral: string;
  productId: number;
  device: string;
  phone?: string;
  auth?: { token: string; applicationId?: number };
};
type Action = (typeof controls)[keyof typeof controls] & {
  nodeId: string;
  fields?: { name: string; label: string; type: string; required: boolean; options?: string[] }[];
};
type DocumentUpload = { nodeId: string; documents: { code: string; required: boolean }[] };
type Operation =
  | { name: 'entry'; referral?: string }
  | { name: 'status' }
  | { name: 'requestOtp'; phone: string }
  | { name: 'verifyOtp'; otp: string }
  | { name: 'step'; nodeId: string; values: RecordValue };

function object(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: RecordValue, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function https(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function parseBorrowerOnboardingConfig(value: string | undefined): Config | null {
  try {
    const parsed = JSON.parse(value ?? 'null');
    if (
      !object(parsed) ||
      !keys(parsed, ['origin', 'organizationId', 'furyUrl', 'lspSecret', 'returnUrl', 'providerOrigins'])
    )
      return null;
    const scope = applicantScope(parsed);
    const { returnUrl, providerOrigins } = parsed;
    const returnTo = https(returnUrl);
    if (
      !scope ||
      !returnTo ||
      returnTo.origin !== scope.origin ||
      !returnTo.pathname.startsWith('/applications/') ||
      returnTo.search ||
      returnTo.hash ||
      !Array.isArray(providerOrigins) ||
      !providerOrigins.length ||
      providerOrigins.length > 12 ||
      !providerOrigins.every((item) => typeof item === 'string' && https(item)?.origin === item)
    )
      return null;
    return { ...scope, returnUrl: returnTo.href, providerOrigins };
  } catch {
    return null;
  }
}

const positiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;

function operation(value: unknown): Operation {
  if (!object(value) || !keys(value, ['operation', 'fields', 'referralToken']) || !object(value.fields))
    return rejected(400);
  const fields = value.fields;
  if (value.operation === 'entry' && !Object.keys(fields).length) {
    if (value.referralToken === undefined) return { name: 'entry' };
    if (isApplicantReferral(value.referralToken)) return { name: 'entry', referral: value.referralToken };
    return rejected(400);
  }
  if ('referralToken' in value) return rejected(400);
  if (value.operation === 'status' && !Object.keys(fields).length) return { name: 'status' };
  if (value.operation === 'requestOtp' && keys(fields, ['phone'])) {
    const phone = normalizeApplicantPhone(fields.phone);
    if (phone) return { name: 'requestOtp', phone };
  }
  if (
    value.operation === 'verifyOtp' &&
    keys(fields, ['otp']) &&
    typeof fields.otp === 'string' &&
    /^[0-9]{4,8}$/.test(fields.otp)
  ) {
    return { name: 'verifyOtp', otp: fields.otp };
  }
  if (
    value.operation === 'step' &&
    keys(fields, ['nodeId', 'values']) &&
    typeof fields.nodeId === 'string' &&
    nodePattern.test(fields.nodeId) &&
    object(fields.values) &&
    Object.keys(fields.values).length <= 24 &&
    Object.entries(fields.values).every(
      ([name, answer]) => keyPattern.test(name) && typeof answer === 'string' && answer.length <= 400
    )
  ) {
    return { name: 'step', nodeId: fields.nodeId, values: fields.values };
  }
  return rejected(400);
}

function formFields(value: unknown): Action['fields'] {
  if (!Array.isArray(value) || !value.length || value.length > 24) return;
  const result: NonNullable<Action['fields']> = [];
  const names = new Set<string>();
  for (const field of value) {
    if (
      !object(field) ||
      typeof field.name !== 'string' ||
      !keyPattern.test(field.name) ||
      ['constructor', 'prototype'].includes(field.name) ||
      names.has(field.name) ||
      typeof field.label !== 'string' ||
      !field.label.trim() ||
      field.label.length > 120 ||
      typeof field.type !== 'string' ||
      !fieldTypes.includes(field.type) ||
      typeof field.required !== 'boolean'
    )
      return;
    const { name, label, type, required, options } = field;
    if (
      type === 'select' &&
      (!Array.isArray(options) ||
        !options.length ||
        options.length > 50 ||
        !options.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 80))
    )
      return;
    names.add(name);
    result.push({ name, label, type, required, ...(type === 'select' && { options: options as string[] }) });
  }
  return result;
}

export class BorrowerOnboarding {
  private readonly sessions: ApplicantSessions<State>;
  private readonly fury: ApplicantFury;

  constructor(
    redis: ApplicantRedis,
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.sessions = new ApplicantSessions(redis, 'borrower');
    this.fury = new ApplicantFury(fetcher);
  }

  private gateway(config: Config, field: keyof typeof documents, variables: RecordValue, state?: State) {
    return this.fury.request(config, { field, query: documents[field] }, variables, state);
  }

  private async eligible(config: Config, token: string) {
    try {
      const match = await this.gateway(config, 'borrowerReferralEligibility', { referral_token: token });
      return match.organizationId === config.organizationId && positiveInt(match.productId) ? match.productId : null;
    } catch {
      // Invalid/refused links have the same public shape regardless of cause.
      return null;
    }
  }

  private async journey(config: Config, state: State, key: string) {
    if (!state.auth) return rejected(409);
    if (!state.auth.applicationId) {
      const opened = await this.gateway(
        config,
        'applicationCreateFromReferral',
        {
          referral_token: state.referral,
        },
        state
      );
      if (!positiveInt(opened.id) || opened.product_id !== state.productId) return rejected(503);
      state.auth.applicationId = opened.id;
      await this.sessions.save(key, state);
    }
    const id = state.auth.applicationId;
    const flow = await this.gateway(config, 'applicationFlow', { application_id: id }, state);
    const upstreamSteps = flow.steps;
    if (
      flow.productId !== state.productId ||
      !Array.isArray(upstreamSteps) ||
      !upstreamSteps.length ||
      upstreamSteps.length > 250
    )
      return rejected(503);
    const seen = new Set<string>();
    const actions: Action[] = [];
    const documentUploads: DocumentUpload[] = [];
    const steps = upstreamSteps.map((step) => {
      if (
        !object(step) ||
        typeof step.nodeId !== 'string' ||
        !nodePattern.test(step.nodeId) ||
        seen.has(step.nodeId) ||
        typeof step.stepType !== 'string' ||
        step.stepType.length > 64 ||
        typeof step.status !== 'string' ||
        !/^[a-z_]{1,32}$/.test(step.status)
      )
        return rejected(503);
      const { nodeId, stepType, status } = step;
      seen.add(nodeId);
      let available = false;
      if (status === 'active' && Object.prototype.hasOwnProperty.call(controls, stepType)) {
        const control = controls[stepType as keyof typeof controls];
        const kinds = step.allowedKinds;
        const explicitKind = Array.isArray(kinds) && kinds.includes(control.kind);
        const kindAllowed = explicitKind || (kinds == null && stepType !== 'kyc_pan' && stepType !== 'bank_statement');
        const docs = step.documentRequirements;
        const pendingManual =
          stepType === 'document_collection' && Array.isArray(docs)
            ? docs.flatMap((doc) =>
                doc?.provider === 'manual' &&
                doc.status === 'pending' &&
                typeof doc.type === 'string' &&
                documentCode.test(doc.type)
                  ? [{ code: doc.type, required: doc.required === true }]
                  : []
              )
            : [];
        if (pendingManual.length) {
          available = true;
          documentUploads.push({ nodeId, documents: pendingManual });
        }
        const digilocker =
          Array.isArray(docs) &&
          docs.length > 0 &&
          docs.every((doc) => doc?.provider === 'digilocker' && ['pan', 'aadhaar'].includes(doc.type));
        const fields =
          stepType === 'form'
            ? formFields(step.formFields)
            : stepType === 'kyc_pan'
              ? [{ name: 'value', label: 'PAN', type: 'text', required: true }]
              : undefined;
        if (
          kindAllowed &&
          (stepType === 'form'
            ? fields
            : stepType === 'document_collection'
              ? digilocker
              : upstreamSteps.filter((candidate) => candidate?.stepType === stepType).length === 1)
        ) {
          available = true;
          actions.push({ ...control, nodeId, ...(fields && { fields }) });
        }
      }
      const label =
        typeof step.label === 'string' && step.label.trim() && step.label.length <= 120 ? step.label : stepType;
      return {
        nodeId,
        label,
        status,
        ...(!available && status === 'active' && browserSteps.has(stepType) && { actionUnavailable: true }),
      };
    });
    const request = flow.documentRequest;
    const documentRequest =
      object(request) &&
      typeof request.stepId === 'string' &&
      typeof request.reason === 'string' &&
      request.reason.trim() &&
      request.reason.length <= 500 &&
      Array.isArray(request.requiredDocuments) &&
      request.requiredDocuments.length === 1 &&
      request.requiredDocuments[0] === 'bank_statement' &&
      actions.some(({ nodeId, kind }) => nodeId === request.stepId && kind === 'AA')
        ? { stepId: request.stepId, reason: request.reason, requiredDocuments: ['bank_statement'] }
        : undefined;
    return { id, steps, actions, documentRequest, documentUploads };
  }

  private async view(config: Config, state: State, key: string) {
    const { id, steps, actions, documentRequest, documentUploads } = await this.journey(config, state, key);
    return {
      id,
      steps,
      actions: actions.map(({ nodeId, label, fields }) => ({ nodeId, label, ...(fields && { fields }) })),
      ...(documentUploads.length > 0 && { documentUploads }),
      ...(documentRequest && { documentRequest }),
    };
  }

  private async step(config: Config, state: State, cacheKey: string, selected: Extract<Operation, { name: 'step' }>) {
    const view = await this.journey(config, state, cacheKey);
    const action = view.actions.find(({ nodeId }) => nodeId === selected.nodeId);
    if (!action) return rejected(409);
    if (!keys(selected.values, action.fields?.map(({ name }) => name) ?? [])) return rejected(400);
    let data: RecordValue = { redirectUrl: config.returnUrl };
    if (action.type === 'BANK_STATEMENT') {
      if (!state.phone) return rejected(409);
      data = { ...data, mobile: state.phone };
    } else if (action.kind === 'DIGILOCKER') {
      data = { ...data, nodeId: action.nodeId };
    } else if (action.kind === 'PAN') {
      const value = typeof selected.values.value === 'string' ? selected.values.value.trim().toUpperCase() : '';
      if (!/^[A-Z]{3}[ABCFGHLJPT][A-Z][0-9]{4}[A-Z]$/.test(value)) return rejected(400);
      data = { value };
    } else if (action.type === 'FORM') {
      data = {
        nodeId: action.nodeId,
        formAnswers: Object.fromEntries(
          action.fields!.flatMap(({ name, type }) => {
            const answer = selected.values[name];
            if (answer === undefined) return [];
            return [
              [name, type === 'boolean' && (answer === 'Yes' || answer === 'No') ? String(answer === 'Yes') : answer],
            ];
          })
        ),
      };
    }
    const result = await this.gateway(
      config,
      'executeFlowStep',
      {
        application_id: view.id,
        type: action.type,
        kind: action.kind,
        data,
      },
      state
    );
    if (!['FlowStepSuccess', 'FlowStepPending', 'FlowStepFailed'].includes(String(result.__typename)))
      return rejected(503);
    const redirect = result.__typename === 'FlowStepPending' && result.redirectUrl ? https(result.redirectUrl) : null;
    if (result.redirectUrl && (!redirect || !config.providerOrigins.includes(redirect.origin))) return rejected(503);
    return {
      state: 'journey',
      journey: await this.view(config, state, cacheKey),
      ...(redirect && { redirectUrl: redirect.href }),
    };
  }

  async upload(config: Config, read: () => Promise<unknown>, sessionId: string | undefined) {
    const key = this.sessions.key(config, sessionId);
    if (!sessionId || !key) return rejected(409);
    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state?.auth?.applicationId) return rejected(409);
      await this.sessions.rate(config, 'upload', sessionId, 20, 120);
      const input = await read();
      if (
        !object(input) ||
        !keys(input, ['nodeId', 'code', 'file']) ||
        typeof input.nodeId !== 'string' ||
        !nodePattern.test(input.nodeId) ||
        typeof input.code !== 'string' ||
        !documentCode.test(input.code) ||
        !Buffer.isBuffer(input.file) ||
        !input.file.length ||
        input.file.length > maxApplicantDocumentBytes
      )
        return rejected(400);

      const { nodeId, code, file } = input;
      const current = await this.journey(config, state, key);
      if (
        !current.documentUploads.some((step) => step.nodeId === nodeId && step.documents.some((d) => d.code === code))
      )
        return rejected(409);

      const body = new FormData();
      body.set('metadata', JSON.stringify({ applicationId: current.id, nodeId, code }));
      body.set('file', new Blob([new Uint8Array(file)]), 'evidence');
      const response = await this.fetcher(new URL('/v2/borrower/document', config.furyUrl), {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(48_000),
        headers: { device: state.device, cookie: `authorization=${state.auth.token}; device=${state.device}` },
        body,
      });
      if ([401, 403, 404, 409, 422].includes(response.status)) return rejected(response.status);
      if (!response.ok || (await response.json())?.attached !== true) return rejected(503);
      return { state: 'journey', journey: await this.view(config, state, key) };
    });
  }

  async run(config: Config | null, input: unknown, id: string | undefined, setCookie: SetCookie) {
    if (!config) return rejected(404);
    const selected = operation(input);
    const key = this.sessions.key(config, id);
    if (!key || !(await this.sessions.get(key))) {
      if (selected.name === 'entry' && selected.referral) {
        await this.sessions.rate(config, 'entry', config.origin, 300, 60);
        await this.sessions.rate(config, 'invite', selected.referral, 100, 60);
        const productId = await this.eligible(config, selected.referral);
        if (!productId) return { state: 'invite' };
        const state = { referral: selected.referral, productId, device: newApplicantHandle() };
        const { id: fresh } = await this.sessions.start(config, state, guestLifetime);
        setCookie(fresh, guestLifetime);
        return { state: 'phone' };
      }
      if (selected.name === 'entry' || selected.name === 'status') return { state: 'invite' };
      return rejected(409);
    }

    return this.sessions.withLock(key, async () => {
      const state = await this.sessions.get(key);
      if (!state) return rejected(409);
      if (selected.name === 'entry' && selected.referral && selected.referral !== state.referral) return rejected(409);
      if (selected.name === 'entry' || selected.name === 'status') {
        return state.auth
          ? { state: 'journey', journey: await this.view(config, state, key) }
          : { state: state.phone ? 'otp' : 'phone' };
      }
      if (selected.name === 'step') return await this.step(config, state, key, selected);
      if (state.auth) return rejected(409);
      if (selected.name === 'requestOtp') {
        if (state.phone && state.phone !== selected.phone) return rejected(409);
        await this.sessions.rate(config, 'send', selected.phone, 3, 600);
        await this.sessions.rate(config, 'send-tenant', config.origin, 100, 60);
        if ((await this.eligible(config, state.referral)) !== state.productId) return rejected(409);
        await this.fury.requestOtp(config, state, selected.phone);
        state.phone = selected.phone;
        await this.sessions.save(key, state);
        return { state: 'otp' };
      }
      if (!state.phone) return rejected(409);
      await this.sessions.rate(config, 'verify', state.phone, 5, 600);
      const { token, seconds } = await this.fury.verifyOtp(config, state, selected.otp);
      state.auth = { token };
      const fresh = await this.sessions.rotate(config, key, state, seconds);
      setCookie(fresh.id, seconds);
      return { state: 'journey', journey: await this.view(config, state, fresh.key) };
    });
  }
}
