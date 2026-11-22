import { createHmac, randomBytes } from 'node:crypto';
import { ApplicantPurpose, ApplicantScope, rejectApplicant } from './fury';

const sessionPattern = /^[A-Za-z0-9_-]{43}$/;
const increment = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n";
const unlock = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0";
const rotate =
  "if redis.call('EXISTS',KEYS[1])~=1 or not redis.call('SET',KEYS[2],ARGV[1],'EX',ARGV[2],'NX') then return 0 end; return redis.call('DEL',KEYS[1])";

export type ApplicantRedis = { call(command: string, ...args: string[]): Promise<unknown> };
export const newApplicantHandle = () => randomBytes(32).toString('base64url');

export class ApplicantSessions<T> {
  constructor(
    private readonly redis: ApplicantRedis,
    private readonly purpose: ApplicantPurpose
  ) {}

  private scopedKey(scope: ApplicantScope, kind: string, id: string) {
    const digest = createHmac('sha256', scope.lspSecret).update(scope.origin).update('\0').update(id).digest('hex');
    return `${this.purpose}-onboarding:{${scope.organizationId}}:${kind}:${digest}`;
  }

  key(scope: ApplicantScope, id: string | undefined) {
    return id && sessionPattern.test(id) ? this.scopedKey(scope, 'state', id) : undefined;
  }

  async rate(scope: ApplicantScope, bucket: string, subject: string, limit: number, seconds: number) {
    const result = await this.redis.call(
      'EVAL',
      increment,
      '1',
      this.scopedKey(scope, bucket, subject),
      String(seconds)
    );
    if (typeof result !== 'number' || result > limit) rejectApplicant(429);
  }

  async start(scope: ApplicantScope, state: T, seconds: number) {
    const id = newApplicantHandle();
    const key = this.scopedKey(scope, 'state', id);
    if ((await this.redis.call('SET', key, JSON.stringify(state), 'EX', String(seconds), 'NX')) !== 'OK')
      return rejectApplicant(503);
    return { id, key };
  }

  async get(key: string) {
    const value = await this.redis.call('GET', key);
    return typeof value === 'string' ? (JSON.parse(value) as T) : null;
  }

  async save(key: string, state: T) {
    if ((await this.redis.call('SET', key, JSON.stringify(state), 'XX', 'KEEPTTL')) !== 'OK') rejectApplicant(409);
  }

  async rotate(scope: ApplicantScope, previousKey: string, state: T, seconds: number) {
    const id = newApplicantHandle();
    const key = this.scopedKey(scope, 'state', id);
    if ((await this.redis.call('EVAL', rotate, '2', previousKey, key, JSON.stringify(state), String(seconds))) !== 1)
      return rejectApplicant(409);
    return { id, key };
  }

  async withLock<R>(key: string, task: () => Promise<R>) {
    const lock = `${key}:lock`;
    const owner = newApplicantHandle();
    if ((await this.redis.call('SET', lock, owner, 'EX', '60', 'NX')) !== 'OK') return rejectApplicant(409);
    try {
      return await task();
    } finally {
      await this.redis.call('EVAL', unlock, '1', lock, owner);
    }
  }
}
