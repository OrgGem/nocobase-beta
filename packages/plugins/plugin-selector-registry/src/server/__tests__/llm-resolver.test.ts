import {
  buildResolverPrompt,
  LLMResolver,
  parseLLMCandidates,
  type SelectorLLMGateway,
} from '../services/llm-resolver';

describe('llm-resolver', () => {
  describe('buildResolverPrompt', () => {
    it('includes the failure context sections', () => {
      const { system, user } = buildResolverPrompt({
        failedSelector: '#btn-123',
        selectorType: 'css',
        failureType: 'not_found',
        errorMessage: 'element not found',
        domSnippet: '<div><button>Go</button></div>',
        candidates: [{ text: 'Go' }],
        history: [{ selector: '#btn-100', selectorType: 'css', status: 'superseded' }],
      });
      expect(system).toContain('JSON');
      expect(user).toContain('#btn-123');
      expect(user).toContain('not_found');
      expect(user).toContain('element not found');
      expect(user).toContain('<button>Go</button>');
      expect(user).toContain('CANDIDATE ELEMENTS');
      expect(user).toContain('#btn-100');
    });

    it('caps the dom snippet', () => {
      const { user } = buildResolverPrompt({
        failedSelector: '#x',
        selectorType: 'css',
        domSnippet: 'A'.repeat(50000),
        maxDomChars: 1000,
      });
      expect(user.length).toBeLessThan(5000);
    });

    it('instructs the LLM to never repropose historical selectors', () => {
      const { system, user } = buildResolverPrompt({
        failedSelector: '#broken',
        selectorType: 'css',
        history: [
          { selector: '#old-1', selectorType: 'css', status: 'superseded' },
          { selector: '#old-2', selectorType: 'css', status: 'rolled_back' },
        ],
      });
      expect(system).toContain('NEVER re-propose');
      expect(system).toContain('SELECTOR HISTORY');
      expect(user).toContain('DO NOT REPROPOSE THESE');
      expect(user).toContain('#old-1');
      expect(user).toContain('#old-2');
    });

    it('omits the history section when no history exists', () => {
      const { user } = buildResolverPrompt({
        failedSelector: '#x',
        selectorType: 'css',
      });
      expect(user).not.toContain('SELECTOR HISTORY');
      expect(user).not.toContain('DO NOT REPROPOSE');
    });
  });

  describe('parseLLMCandidates', () => {
    it('parses a clean JSON object', () => {
      const candidates = parseLLMCandidates(
        JSON.stringify({
          candidates: [{ selector: '[data-testid="go"]', selectorType: 'css', confidence: 0.9, reasoning: 'stable' }],
        }),
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ selector: '[data-testid="go"]', selectorType: 'css', confidence: 0.9 });
    });

    it('strips markdown fences', () => {
      const candidates = parseLLMCandidates(
        '```json\n{"candidates":[{"selector":"#a","selectorType":"css","confidence":0.5}]}\n```',
      );
      expect(candidates).toHaveLength(1);
    });

    it('accepts a bare array', () => {
      const candidates = parseLLMCandidates('[{"selector":"#a"}]');
      expect(candidates).toHaveLength(1);
      expect(candidates[0].selectorType).toBe('css');
      expect(candidates[0].confidence).toBe(0.5);
    });

    it('clamps confidence into [0,1]', () => {
      const candidates = parseLLMCandidates(
        JSON.stringify({
          candidates: [
            { selector: '#a', confidence: 5 },
            { selector: '#b', confidence: -2 },
          ],
        }),
      );
      expect(candidates[0].confidence).toBe(1);
      expect(candidates[1].confidence).toBe(0);
    });

    it('drops empty selectors and caps at three candidates', () => {
      const candidates = parseLLMCandidates(
        JSON.stringify({
          candidates: [
            { selector: '' },
            { selector: '#a' },
            { selector: '#b' },
            { selector: '#c' },
            { selector: '#d' },
          ],
        }),
      );
      expect(candidates.map((candidate) => candidate.selector)).toEqual(['#a', '#b', '#c']);
    });

    it('returns [] for garbage', () => {
      expect(parseLLMCandidates('sorry, I cannot help')).toEqual([]);
      expect(parseLLMCandidates('')).toEqual([]);
    });

    it('normalizes unknown selector types to css', () => {
      const candidates = parseLLMCandidates(
        JSON.stringify({ candidates: [{ selector: '#a', selectorType: 'jquery' }] }),
      );
      expect(candidates[0].selectorType).toBe('css');
    });
  });

  describe('LLMResolver', () => {
    it('round-trips through the gateway', async () => {
      const gateway: SelectorLLMGateway = {
        complete: async ({ system, user }) => {
          expect(system).toBeTruthy();
          expect(user).toContain('#broken');
          return {
            content: JSON.stringify({ candidates: [{ selector: '#fixed', confidence: 0.8 }] }),
            model: 'test-model',
            usage: { promptTokens: 10, completionTokens: 5 },
          };
        },
      };
      const resolver = new LLMResolver(gateway);
      const result = await resolver.resolve({ failedSelector: '#broken', selectorType: 'css' });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].selector).toBe('#fixed');
      expect(result.model).toBe('test-model');
      expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    });
  });
});
