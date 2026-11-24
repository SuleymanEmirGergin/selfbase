// Docker object names and the error every provisioner refusal throws. A ref is checked here before it
// becomes part of any object name, so a hostile ref never reaches Docker (Review Focus 1).

export class ProvisionError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string = code) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const REF_RE = /^[a-z]{20}$/

export function assertRef(ref: unknown): asserts ref is string {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) throw new ProvisionError(400, 'invalid_ref', 'ref must be 20 lowercase letters')
}

export const containerName = (ref: string, service: string) => `sb-${ref}-${service}`
export const networkName = (ref: string) => `sb-${ref}`
// R6: core and control only (core's admin port), and fn's own way out; see spec.ts buildProject
export const ctlNetworkName = (ref: string) => `sb-${ref}-ctl`
export const egressNetworkName = (ref: string) => `sb-${ref}-egress`
export const volumeName = (ref: string, volume: string) => `sb-${ref}-${volume}`
