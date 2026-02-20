import { BaseStrategy, StrategyConfig } from './base-strategy.js';
import { LimitlessClient } from '../core/limitless/markets.js';
import { TradingClient } from '../core/limitless/trading.js';

type StrategyConstructor = new (
    config: StrategyConfig,
    deps: { limitless: LimitlessClient; trading: TradingClient }
) => BaseStrategy;

const registry = new Map<string, StrategyConstructor>();

export function registerStrategy(type: string, cls: StrategyConstructor) {
    registry.set(type, cls);
}

import { SignalSniperStrategy } from './signal-sniper/index.js';
import { ComplementArbStrategy } from './cross-market-arb/index.js';

// Register built-in strategies
registerStrategy('signal-sniper', SignalSniperStrategy);
registerStrategy('cross-market-arb', ComplementArbStrategy);

export function createStrategy(
    config: StrategyConfig,
    deps: { limitless: LimitlessClient; trading: TradingClient }
): BaseStrategy {
    const cls = registry.get(config.type);
    if (!cls) {
        throw new Error(`Unknown strategy type: ${config.type}. Available: ${Array.from(registry.keys()).join(', ')}`);
    }
    return new cls(config, deps);
}
