/** Content-script modules that run without a DOM: the service-worker count. */

import {describe, expect, it} from 'vitest';
import {countServiceWorkers} from '../../src/content/swCheck.ts';

describe('service workers', () => {
  const no = (): boolean => false;
  const yes = (): boolean => true;

  it('counts registrations, and treats an unavailable API as none', async () => {
    const two = async (): Promise<readonly unknown[]> => [{}, {}];
    expect(await countServiceWorkers({getRegistrations: two, controlled: no})).toBe(2);
    expect(await countServiceWorkers({getRegistrations: two, controlled: yes})).toBe(2);
    expect(await countServiceWorkers({getRegistrations: null, controlled: no})).toBe(0);
  });

  it('a worker that controls the document counts although no registration is listed', async () => {
    const none = async (): Promise<readonly unknown[]> => [];
    expect(await countServiceWorkers({getRegistrations: none, controlled: yes})).toBe(1);
    expect(await countServiceWorkers({getRegistrations: none, controlled: no})).toBe(0);
    // The list cannot be read (Firefox rejects it in some contexts): the controller still counts.
    const refused = (): Promise<readonly unknown[]> => Promise.reject(new Error('insecure'));
    expect(await countServiceWorkers({getRegistrations: refused, controlled: yes})).toBe(1);
    expect(await countServiceWorkers({getRegistrations: refused, controlled: no})).toBe(0);
    const broken = (): boolean => {
      throw new Error('no controller');
    };
    expect(await countServiceWorkers({getRegistrations: none, controlled: broken})).toBe(0);
  });
});
