/**
 * Build the configured proxy provider.
 *
 * One place that turns config into a provider, so the engine never branches on
 * `proxy.mode` and adding a provider is a change here plus a schema enum entry.
 */
import type { ResolvedConfig } from '../../config/schema.js';
import { ConfigError } from '../errors/taxonomy.js';
import { resolvePath } from '../util/paths.js';
import {
  NoProxyProvider,
  RotatingGatewayProvider,
  StaticListProvider,
  type ProxyPolicy,
} from './providers.js';
import type { ProxyProvider } from './types.js';

export function createProxyProvider(config: ResolvedConfig): ProxyProvider {
  const policy: ProxyPolicy = {
    maxConsecutiveFailures: config.proxy.maxConsecutiveFailures,
    banCooldownSeconds: config.proxy.banCooldownSeconds,
  };

  switch (config.proxy.mode) {
    case 'none':
      return new NoProxyProvider();

    case 'list': {
      const file = config.proxy.list.file;
      if (file === undefined) {
        // The schema's superRefine already catches this; kept so the function
        // is safe to call with a hand-built config too.
        throw new ConfigError('proxy.list.file is required when proxy.mode is "list".', {
          code: 'CONFIG_INVALID',
        });
      }
      return StaticListProvider.fromFile(
        resolvePath(file, config.paths.root),
        policy,
        config.proxy.list.defaultScheme,
      );
    }

    case 'gateway': {
      const gateway = config.proxy.gateway;
      if (gateway.server === undefined) {
        throw new ConfigError('proxy.gateway.server is required when proxy.mode is "gateway".', {
          code: 'CONFIG_INVALID',
        });
      }
      return new RotatingGatewayProvider(
        {
          server: gateway.server,
          username: gateway.username ?? '',
          password: gateway.password ?? '',
          ...(gateway.sessionPattern !== undefined && { sessionPattern: gateway.sessionPattern }),
          sessionTtlSeconds: gateway.sessionTtlSeconds,
          ...(gateway.country !== undefined && { country: gateway.country }),
        },
        policy,
      );
    }
  }
}
