import {
  describeElement,
  extractNeighborhood,
  parseDom,
  selectCss,
  selectOneCss,
  trimDomSnippet,
  validateSelector,
} from '../services/dom-analyzer';

const SAMPLE = `
<html>
<head><title>Test</title><style>.x{color:red}</style></head>
<body>
  <form id="login-form">
    <input data-testid="username" name="username" placeholder="User" />
    <input type="password" name="password" />
    <button id="btn-submit-1234" aria-label="Sign in">Sign in</button>
    <a href="/help">Help</a>
  </form>
  <script>var secret = "token";</script>
</body>
</html>
`;

describe('dom-analyzer', () => {
  describe('selectCss / selectOneCss', () => {
    it('selects elements with valid CSS', () => {
      const dom = parseDom(SAMPLE);
      const { ok, elements } = selectCss(dom, 'input[name="username"]');
      expect(ok).toBe(true);
      expect(elements).toHaveLength(1);
      expect(selectOneCss(dom, '#login-form button')).not.toBeNull();
    });

    it('reports invalid selectors as not ok instead of throwing', () => {
      const dom = parseDom(SAMPLE);
      const result = selectCss(dom, '///not-css[[[');
      expect(result.ok).toBe(false);
      expect(selectOneCss(dom, '///not-css[[[')).toBeNull();
    });
  });

  describe('validateSelector', () => {
    it('counts matches and detects uniqueness', () => {
      const dom = parseDom(SAMPLE);
      expect(validateSelector(dom, 'input', 'css')).toMatchObject({ validatable: true, matchCount: 2, unique: false });
      expect(validateSelector(dom, '[data-testid="username"]', 'css')).toMatchObject({
        validatable: true,
        matchCount: 1,
        unique: true,
      });
      expect(validateSelector(dom, '[data-testid="missing"]', 'css')).toMatchObject({
        validatable: true,
        matchCount: 0,
        unique: false,
      });
    });

    it('marks non-css selectors as not validatable server-side', () => {
      const dom = parseDom(SAMPLE);
      expect(validateSelector(dom, '//button', 'xpath').validatable).toBe(false);
      expect(validateSelector(dom, 'Sign in', 'text').validatable).toBe(false);
    });

    it('treats empty selectors as zero matches', () => {
      const dom = parseDom(SAMPLE);
      expect(validateSelector(dom, '   ', 'css')).toMatchObject({ validatable: true, matchCount: 0 });
    });
  });

  describe('describeElement', () => {
    it('captures tag, attributes and collapsed text', () => {
      const dom = parseDom(SAMPLE);
      const button = selectOneCss(dom, '#login-form button');
      if (!button) {
        throw new Error('Expected to find "#login-form button" in the sample DOM.');
      }
      const descriptor = describeElement(button);
      expect(descriptor.tag).toBe('button');
      expect(descriptor.attrs['aria-label']).toBe('Sign in');
      expect(descriptor.text).toBe('Sign in');
      expect(descriptor.textHash).toHaveLength(32);
    });
  });

  describe('trimDomSnippet', () => {
    it('strips script/style/head noise', () => {
      const output = trimDomSnippet(SAMPLE);
      expect(output).not.toContain('secret');
      expect(output).not.toContain('<style>');
      expect(output).not.toContain('<title>');
      expect(output).toContain('data-testid="username"');
    });

    it('truncates huge snippets at a tag boundary', () => {
      const huge = `<div>${'<span>hello world </span>'.repeat(500)}</div>`;
      const output = trimDomSnippet(huge, 500);
      expect(output.length).toBeLessThanOrEqual(500 + '<!-- truncated -->'.length + 1);
      expect(output).toContain('<!-- truncated -->');
    });
  });

  describe('extractNeighborhood', () => {
    it('returns the subtree around the matched element', () => {
      const output = extractNeighborhood(SAMPLE, '[data-testid="username"]', 'css');
      expect(output).toContain('data-testid="username"');
      expect(output).toContain('login-form');
      expect(output).not.toContain('secret');
    });

    it('falls back to the trimmed snippet when the selector is gone', () => {
      const output = extractNeighborhood(SAMPLE, '#does-not-exist', 'css');
      expect(output).toContain('login-form');
    });
  });
});
