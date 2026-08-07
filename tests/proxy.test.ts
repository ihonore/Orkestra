import { describe, expect, it } from 'vitest';
import { parseProxyLine, parseProxyList, stickyUsername } from '../src/core/proxy/parse.js';
import {
  NoProxyProvider,
  RotatingGatewayProvider,
  StaticListProvider,
} from '../src/core/proxy/providers.js';
import type { ParsedProxyLine } from '../src/core/proxy/parse.js';

describe('proxy line parsing', () => {
  it('parses host:port', () => {
    expect(parseProxyLine('1.2.3.4:8080').settings).toEqual({ server: 'http://1.2.3.4:8080' });
  });

  it('parses the host:port:user:pass form providers hand out', () => {
    expect(parseProxyLine('1.2.3.4:8080:alice:s3cret').settings).toEqual({
      server: 'http://1.2.3.4:8080',
      username: 'alice',
      password: 's3cret',
    });
  });

  it('lifts URL userinfo into separate fields', () => {
    // This is the whole point: Playwright rebuilds `server` from protocol and
    // host and silently drops userinfo, so credentials left in the URL never
    // reach the proxy. Verified against Playwright 1.62.
    const parsed = parseProxyLine('http://alice:s3cret@1.2.3.4:8080');
    expect(parsed.settings.server).toBe('http://1.2.3.4:8080');
    expect(parsed.settings.username).toBe('alice');
    expect(parsed.settings.password).toBe('s3cret');
  });

  it('decodes percent-encoded credentials', () => {
    const parsed = parseProxyLine('http://user%40corp:p%3Ass@1.2.3.4:8080');
    expect(parsed.settings.username).toBe('user@corp');
    expect(parsed.settings.password).toBe('p:ss');
  });

  it('brackets an IPv6 host so the server URL parses', () => {
    expect(parseProxyLine('http://[2001:db8::1]:8080').settings.server).toBe(
      'http://[2001:db8::1]:8080',
    );
  });

  it('refuses authenticated SOCKS at config time, not at first use', () => {
    // Playwright throws on SOCKS with credentials, and it would surface hours
    // into a run at context creation.
    expect(() => parseProxyLine('socks5://user:pass@1.2.3.4:1080')).toThrowError(
      /SOCKS proxies cannot carry credentials/,
    );
  });

  it('allows SOCKS without credentials', () => {
    expect(parseProxyLine('socks5://1.2.3.4:1080').settings.server).toBe('socks5://1.2.3.4:1080');
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseProxyLine('1.2.3.4:99999')).toThrowError(/Invalid proxy port/);
  });

  it('rejects an unsupported scheme', () => {
    expect(() => parseProxyLine('ftp://1.2.3.4:21')).toThrowError(/Unsupported proxy scheme/);
  });

  it('never leaves credentials in the server field', () => {
    for (const line of ['http://u:p@h:1', 'h:1:u:p', 'https://u:p@h:2']) {
      expect(parseProxyLine(line).settings.server).not.toMatch(/@/);
    }
  });
});

describe('proxy list parsing', () => {
  it('skips blanks and comments, and reports the offending line number', () => {
    const list = parseProxyList('# header\n\n1.2.3.4:8080\n\n5.6.7.8:9090:u:p\n');
    expect(list).toHaveLength(2);

    expect(() => parseProxyList('1.2.3.4:8080\nnonsense\n')).toThrowError(/line 2/);
  });
});

describe('sticky session usernames', () => {
  it('substitutes the session token into the provider pattern', () => {
    expect(stickyUsername('{username}-session-{session}', 'acct', 'abc123')).toBe(
      'acct-session-abc123',
    );
    expect(stickyUsername('user-{username}-sessid-{session}', 'acct', 'xyz')).toBe(
      'user-acct-sessid-xyz',
    );
  });

  it('refuses a pattern with no {session}, which would pin one exit IP forever', () => {
    expect(() => stickyUsername('{username}-static', 'acct', 'abc')).toThrowError(/\{session\}/);
  });
});

function entries(...labels: string[]): ParsedProxyLine[] {
  return labels.map((label) => ({
    settings: { server: `http://${label}` },
    label,
  }));
}

describe('static list provider', () => {
  it('hands out distinct identities', () => {
    const provider = new StaticListProvider(entries('a:1', 'b:2', 'c:3'));
    const ids = [
      provider.acquire('browser')?.id,
      provider.acquire('browser')?.id,
      provider.acquire('browser')?.id,
    ];
    expect(new Set(ids).size).toBe(3);
  });

  it('returns null rather than falling back to a direct connection', () => {
    // Silently scraping from the host IP is how a residential-proxy setup
    // starts hitting Google from the office connection.
    const provider = new StaticListProvider(entries('a:1'));
    provider.acquire('browser');
    expect(provider.acquire('browser')).toBeNull();
  });

  it('reuses least-recently-used first, maximising rest between uses', () => {
    const provider = new StaticListProvider(entries('a:1', 'b:2'));
    const first = provider.acquire('browser', 1000)!;
    const second = provider.acquire('browser', 1001)!;
    provider.release(first, 'ok', 1002);
    provider.release(second, 'ok', 1003);

    // `first` has rested longest, so it comes back first.
    expect(provider.acquire('browser', 2000)?.id).toBe(first.id);
  });

  it('benches an identity immediately when it is blocked', () => {
    const provider = new StaticListProvider(entries('a:1', 'b:2'), {
      maxConsecutiveFailures: 3,
      banCooldownSeconds: 60,
    });
    const session = provider.acquire('browser', 1000)!;
    provider.release(session, 'blocked', 1000);

    const health = provider.health().find((h) => h.id === session.id)!;
    expect(health.healthy).toBe(false);
    expect(health.blocks).toBe(1);
    expect(health.cooldownUntil).toBe(1000 + 60_000);
  });

  it('benches only after repeated errors, since one timeout is not a ban', () => {
    const provider = new StaticListProvider(entries('a:1'), {
      maxConsecutiveFailures: 3,
      banCooldownSeconds: 60,
    });

    for (let i = 0; i < 2; i += 1) {
      const s = provider.acquire('browser', 1000)!;
      provider.release(s, 'timeout', 1000);
      expect(provider.health()[0]?.healthy).toBe(true);
    }

    const third = provider.acquire('browser', 1000)!;
    provider.release(third, 'timeout', 1000);
    expect(provider.health()[0]?.healthy).toBe(false);
  });

  it('clears a failure streak after a success', () => {
    const provider = new StaticListProvider(entries('a:1'), {
      maxConsecutiveFailures: 2,
      banCooldownSeconds: 60,
    });
    provider.release(provider.acquire('browser', 1000)!, 'error', 1000);
    provider.release(provider.acquire('browser', 1001)!, 'ok', 1001);
    provider.release(provider.acquire('browser', 1002)!, 'error', 1002);

    expect(provider.health()[0]?.healthy).toBe(true);
  });

  it('returns a rested identity to service once its cooldown expires', () => {
    const provider = new StaticListProvider(entries('a:1'), {
      maxConsecutiveFailures: 3,
      banCooldownSeconds: 60,
    });
    provider.release(provider.acquire('browser', 1000)!, 'blocked', 1000);

    expect(provider.acquire('browser', 30_000)).toBeNull();
    expect(provider.acquire('browser', 61_001)).not.toBeNull();
  });

  it('refuses an empty list rather than silently going direct', () => {
    expect(() => new StaticListProvider([])).toThrowError(/empty/);
  });
});

describe('rotating gateway provider', () => {
  const config = {
    server: 'http://gw.example.com:7777',
    username: 'acct',
    password: 'pw',
    sessionPattern: '{username}-session-{session}',
  };

  it('encodes a distinct sticky session in the username each time', () => {
    const provider = new RotatingGatewayProvider(config);
    const a = provider.acquire('browser')!;
    const b = provider.acquire('browser')!;

    expect(a.settings.username).toMatch(/^acct-session-[0-9a-f]+$/);
    expect(a.settings.username).not.toBe(b.settings.username);
    // The endpoint never changes; only the identity encoded into it does.
    expect(a.settings.server).toBe(config.server);
  });

  it('keeps credentials out of the server URL', () => {
    const session = new RotatingGatewayProvider(config).acquire('browser')!;
    expect(session.settings.server).not.toMatch(/@/);
    expect(session.settings.password).toBe('pw');
  });

  it('discards a burned session so its exit IP is not reused', () => {
    const provider = new RotatingGatewayProvider(config);
    const session = provider.acquire('browser')!;
    provider.release(session, 'blocked');
    expect(provider.health().find((h) => h.id === session.id)).toBeUndefined();
  });

  it('stops issuing sessions while the gateway itself is cooling down', () => {
    const provider = new RotatingGatewayProvider(config, {
      maxConsecutiveFailures: 3,
      banCooldownSeconds: 60,
    });
    provider.cooldown(1000);
    expect(provider.acquire('browser', 5000)).toBeNull();
    expect(provider.acquire('browser', 61_001)).not.toBeNull();
  });

  it('refuses a SOCKS gateway, which cannot carry a session token', () => {
    expect(
      () => new RotatingGatewayProvider({ ...config, server: 'socks5://gw:1080' }),
    ).toThrowError(/SOCKS/);
  });
});

describe('no-proxy provider', () => {
  it('always yields a direct session and reports no health', () => {
    const provider = new NoProxyProvider();
    expect(provider.acquire('browser').settings.server).toBe('');
    expect(provider.health()).toEqual([]);
  });
});
