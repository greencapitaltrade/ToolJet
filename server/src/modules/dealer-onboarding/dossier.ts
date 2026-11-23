import { ApplicantScope, rejectApplicant } from '../applicant-session/fury';

const forms = { SAVE_HISTORY: 'history', SAVE_EXECUTION: 'execution', SAVE_OWN_DIN: 'own_din' } as const;
type SaveAction = keyof typeof forms;
type DossierInput = { action: 'STATUS' } | { action: SaveAction; version: number; fields: Record<string, unknown> };
type Subject = { referralToken: string; draftId: string; device: string; token: string };

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isSave = (value: unknown): value is SaveAction =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(forms, value);

export function dealerDossierInput(input: unknown): DossierInput {
  if (!object(input)) return rejectApplicant(400);
  const { action, version, fields } = input;
  if (action === 'STATUS' && Object.keys(input).length === 1) return { action };
  if (
    !isSave(action) ||
    Object.keys(input).length !== 3 ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !object(fields)
  )
    return rejectApplicant(400);
  return { action, version, fields };
}

export async function requestDealerDossier(
  scope: ApplicantScope,
  { referralToken, draftId, device, token }: Subject,
  input: DossierInput,
  fetcher: typeof fetch
) {
  const send = async (command: DossierInput) => {
    const response = await fetcher(new URL('/v2/dealer/dossier', scope.furyUrl), {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', device, cookie: `authorization=${token}; device=${device}` },
      body: JSON.stringify({ variables: { draftId, referralToken, ...command } }),
    });
    if (!response.ok) return rejectApplicant([409, 422].includes(response.status) ? response.status : 503);
    const data: unknown = await response.json();
    if (!object(data)) return rejectApplicant(503);
    const { version, history, execution, own_din } = data;
    if (
      typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !(history === null || history === 'bank' || history === 'bank_and_gst') ||
      !(execution === null || execution === 'registered_entity' || execution === 'registration_details') ||
      !(own_din === null || own_din === 'DIN' || own_din === 'DPIN')
    )
      return rejectApplicant(503);
    return { version, history, execution, own_din };
  };
  const current = await send({ action: 'STATUS' });
  if (input.action === 'STATUS') return current;
  if (input.version !== current.version || !current[forms[input.action]]) return rejectApplicant(409);
  return send(input);
}
