import { test, expect } from 'bun:test';
import './setup';
const { checkRank } = await import('../backend/transport');

test('the small check through an exit asks DeepSeek 4.1 Flash first, then GLM 5.3 Flash, then MiniMax M3.1 Flash, then any other model', () => {
  const ids = ['opencode/nemotron-3.5-lightning-free', 'opencode/minimax-m3.1-flash-free', 'opencode/glm-5.3-flash-free', 'opencode/big-pickle', 'opencode/deepseek-v4.1-flash-free'];
  const ordered = [...ids].sort((a, b) => checkRank(a) - checkRank(b));
  expect(ordered.slice(0, 3)).toEqual(['opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free', 'opencode/minimax-m3.1-flash-free']);
  expect(checkRank('opencode/nemotron-3.5-lightning-free')).toBe(checkRank('opencode/big-pickle'));
});
