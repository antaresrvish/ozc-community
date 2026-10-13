/** What `minecraft status` reads off the cluster's objects and the server's own answer. */
import { describe, expect, it } from 'bun:test'

import { addressOf, playersOf, readinessOf } from '../src/internal/status'

describe('the address', () => {
  it('is the LoadBalancer address with the port, or pending until the cluster gives one', () => {
    const service = { spec: { type: 'LoadBalancer', ports: [{ port: 25_565 }] } }

    expect(
      addressOf({ ...service, status: { loadBalancer: { ingress: [{ ip: '5.1.2.3' }] } } }),
    ).toBe('5.1.2.3:25565')
    expect(addressOf({ ...service, status: { loadBalancer: {} } })).toBe('pending (port 25565)')
  })

  it('is any node with the NodePort, the Service name in-cluster, and nothing without a Service', () => {
    expect(
      addressOf({ spec: { type: 'NodePort', ports: [{ port: 25_565, nodePort: 30_565 }] } }),
    ).toBe('<any node>:30565')
    expect(
      addressOf({
        metadata: { name: 'lan' },
        spec: { type: 'ClusterIP', ports: [{ port: 25_566 }] },
      }),
    ).toBe('in-cluster lan:25566')
    expect(addressOf(undefined)).toBe('-')
  })
})

describe('the readiness', () => {
  it('is read off the pod: absent, pending, running but not ready, ready, or stopped', () => {
    expect(readinessOf(undefined)).toBe('absent')
    expect(readinessOf({ status: { phase: 'Pending' } })).toBe('starting')
    expect(readinessOf({ status: { phase: 'Running', conditions: [] } })).toBe('starting')
    expect(
      readinessOf({
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
      }),
    ).toBe('ready')
    expect(readinessOf({ status: { phase: 'Failed' } })).toBe('stopped')
  })
})

describe('the players', () => {
  it("are read off the server's answer to list", () => {
    expect(playersOf('There are 2 of a max of 20 players online: steve, alex\n')).toBe(
      '2/20: steve, alex',
    )
    expect(playersOf('There are 0 of a max of 20 players online:')).toBe('0/20')
    expect(playersOf('Unknown command')).toBeUndefined()
  })
})
