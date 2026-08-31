import { heuristicRepair } from '../services/heuristic-repair';

const PAGE = `
<html><body>
  <form id="login-form">
    <input name="username" placeholder="Username" />
    <button id="btn-submit-5678" data-testid="submit" aria-label="Submit">Submit</button>
    <button class="secondary">Cancel</button>
  </form>
  <div class="list">
    <span class="row">A</span>
    <span class="row">B</span>
  </div>
</body></html>
`;

describe('heuristic-repair', () => {
  it('validates a client-provided selector that is unique in the snapshot', () => {
    const candidates = heuristicRepair({
      failedSelector: '#btn-submit-1234',
      selectorType: 'css',
      domSnippet: PAGE,
      candidates: [{ selector: '[data-testid="submit"]' }],
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].selector).toBe('[data-testid="submit"]');
    expect(candidates[0].source).toBe('client-candidate');
    expect(candidates[0].unique).toBe(true);
  });

  it('locates an element from client-provided attributes', () => {
    const candidates = heuristicRepair({
      failedSelector: '#gone',
      selectorType: 'css',
      domSnippet: PAGE,
      candidates: [{ tag: 'input', attrs: { name: 'username' } }],
    });
    expect(candidates.some((candidate) => candidate.selector === 'input[name="username"]')).toBe(true);
  });

  it('ignores client selectors that match multiple elements', () => {
    const candidates = heuristicRepair({
      failedSelector: '.row',
      selectorType: 'css',
      domSnippet: PAGE,
      candidates: [{ selector: 'span.row' }],
    });
    expect(candidates.filter((candidate) => candidate.source === 'client-candidate')).toHaveLength(0);
  });

  it('repairs dynamic id drift with a prefix anchor', () => {
    const candidates = heuristicRepair({
      failedSelector: '#btn-submit-1234',
      selectorType: 'css',
      domSnippet: PAGE,
    });
    const drift = candidates.find((candidate) => candidate.source === 'id-drift');
    expect(drift).toBeDefined();
    expect(drift?.selector).toBe('[id^="btn-submit"]');
    expect(drift?.unique).toBe(true);
  });

  it('reanchors on the final unique segment of a broken structural selector', () => {
    const candidates = heuristicRepair({
      failedSelector: 'form#login-form > div.missing > input[name="username"]',
      selectorType: 'css',
      domSnippet: PAGE,
    });
    const reanchor = candidates.find((candidate) => candidate.source === 'segment-reanchor');
    expect(reanchor).toBeDefined();
    expect(reanchor?.selector).toBe('input[name="username"]');
  });

  it('falls back to a text anchor when nothing else survives', () => {
    const candidates = heuristicRepair({
      failedSelector: '//button[@id="gone"]',
      selectorType: 'xpath',
      candidates: [{ text: 'Submit' }],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ selector: 'Submit', selectorType: 'text', unique: false });
  });

  it('does not emit a text anchor when a css repair exists', () => {
    const candidates = heuristicRepair({
      failedSelector: '#btn-submit-1234',
      selectorType: 'css',
      domSnippet: PAGE,
      candidates: [{ text: 'Submit' }],
    });
    expect(candidates.every((candidate) => candidate.selectorType !== 'text')).toBe(true);
  });

  it('excludes selectors the client already tried', () => {
    const candidates = heuristicRepair({
      failedSelector: '#btn-submit-1234',
      selectorType: 'css',
      domSnippet: PAGE,
      triedSelectors: ['[id^="btn-submit"]'],
    });
    expect(candidates.find((candidate) => candidate.selector === '[id^="btn-submit"]')).toBeUndefined();
  });

  it('ranks candidates that resemble the stored signature first', () => {
    const candidates = heuristicRepair({
      failedSelector: '#btn-submit-1234',
      selectorType: 'css',
      domSnippet: PAGE,
      candidates: [{ selector: 'button.secondary' }, { selector: '[data-testid="submit"]' }],
      signature: {
        tag: 'button',
        stableAttrs: { 'data-testid': 'submit', 'aria-label': 'Submit' },
        textSample: 'Submit',
        textHash: 'x',
      },
    });
    expect(candidates[0].selector).toBe('[data-testid="submit"]');
    expect(candidates[0].signatureScore).toBeGreaterThan(0.8);
  });

  it('returns nothing without a snapshot or candidates', () => {
    expect(heuristicRepair({ failedSelector: '#x', selectorType: 'css' })).toHaveLength(0);
  });

  describe('xpath-id-extract', () => {
    it('converts an XPath @id reference to a CSS prefix anchor', () => {
      const candidates = heuristicRepair({
        failedSelector: '//button[@id="btn-submit-5678"]',
        selectorType: 'xpath',
        domSnippet: PAGE,
      });
      const xpathExtract = candidates.find((candidate) => candidate.source === 'xpath-id-extract');
      expect(xpathExtract).toBeDefined();
      expect(xpathExtract?.selector).toBe('[id^="btn-submit"]');
      expect(xpathExtract?.unique).toBe(true);
      expect(xpathExtract?.selectorType).toBe('css');
    });

    it('ignores XPath without dynamic id suffix', () => {
      const candidates = heuristicRepair({
        failedSelector: '//button[@id="stable-id"]',
        selectorType: 'xpath',
        domSnippet: PAGE,
      });
      expect(candidates.filter((candidate) => candidate.source === 'xpath-id-extract')).toHaveLength(0);
    });

    it('ignores XPath id that matches multiple elements', () => {
      const ambiguousPage = `
        <div><span id="row-1">A</span><span id="row-2">B</span></div>
      `;
      const candidates = heuristicRepair({
        failedSelector: '//span[@id="row-999"]',
        selectorType: 'xpath',
        domSnippet: ambiguousPage,
      });
      // [id^="row"] would match 2 elements -> not unique -> not emitted
      expect(candidates.filter((candidate) => candidate.source === 'xpath-id-extract')).toHaveLength(0);
    });

    it('combines with other strategies for xpath input', () => {
      const candidates = heuristicRepair({
        failedSelector: '//button[@id="btn-submit-5678"]',
        selectorType: 'xpath',
        domSnippet: PAGE,
        candidates: [{ text: 'Submit' }],
      });
      // xpath-id-extract should produce a CSS candidate, text anchor should NOT fire
      expect(candidates.some((candidate) => candidate.source === 'xpath-id-extract')).toBe(true);
      expect(candidates.every((candidate) => candidate.selectorType !== 'text')).toBe(true);
    });
  });
});
