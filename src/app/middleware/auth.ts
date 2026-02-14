import type { Request, Response, NextFunction } from 'express';
import { config } from '../../config/index.js';

function makeBearerAuth(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    // If no token is configured, allow (useful for local dev).
    if (!expectedToken) return next();

    const header = req.header('authorization') || '';
    const expected = `Bearer ${expectedToken}`;
    if (header !== expected) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };
}

// Auth between blackjack-backend -> whisper-server
export const backendAuthMiddleware = makeBearerAuth(config.whisperToken);

// Auth for operator-only endpoints (connect flows, manual triggers)
export const operatorAuthMiddleware = makeBearerAuth(config.whisperOperatorToken);

// Backwards-compat alias (prefer backendAuthMiddleware/operatorAuthMiddleware)
export const authMiddleware = backendAuthMiddleware;

