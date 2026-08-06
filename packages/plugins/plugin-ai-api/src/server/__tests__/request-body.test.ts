import http from 'http';
import type { AddressInfo } from 'net';
import { MAX_REQUEST_BODY_MB_LIMIT, getRawBody, normalizeMaxRequestBodyMb } from '../routes/router';
import { findContentBlockProblem, findMessageProblem, normalizeMessageContent } from '../routes/chat-completions';

describe('AI API max request body configuration', () => {
  it('falls back to 10 MB when the configured value is missing or unusable', () => {
    expect(normalizeMaxRequestBodyMb(undefined)).toBe(10);
    expect(normalizeMaxRequestBodyMb(null)).toBe(10);
    expect(normalizeMaxRequestBodyMb('not a number')).toBe(10);
    expect(normalizeMaxRequestBodyMb(0)).toBe(10);
    expect(normalizeMaxRequestBodyMb(-5)).toBe(10);
    expect(normalizeMaxRequestBodyMb(2.5)).toBe(10);
  });

  it('accepts a raised limit and clamps anything above the ceiling', () => {
    expect(normalizeMaxRequestBodyMb(25)).toBe(25);
    expect(normalizeMaxRequestBodyMb('25')).toBe(25);
    expect(normalizeMaxRequestBodyMb(MAX_REQUEST_BODY_MB_LIMIT)).toBe(MAX_REQUEST_BODY_MB_LIMIT);
    expect(normalizeMaxRequestBodyMb(MAX_REQUEST_BODY_MB_LIMIT + 1)).toBe(MAX_REQUEST_BODY_MB_LIMIT);
    expect(normalizeMaxRequestBodyMb(Number.MAX_SAFE_INTEGER)).toBe(MAX_REQUEST_BODY_MB_LIMIT);
  });
});

/**
 * Drives the real getRawBody over a live socket.
 *
 * The point is the transport, not the arithmetic: ctx.req and the response share
 * one TCP connection, so destroying the request also destroys the reply and the
 * client sees ECONNRESET instead of our 413 JSON. Only an end-to-end socket test
 * can catch that regression, so this must call the production helper rather than
 * a copy of it.
 */
describe('AI API oversized request handling', () => {
  const MAX_BYTES = 1024;

  interface Outcome {
    status?: number;
    body: string;
    clientError?: string;
  }

  async function reply(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json');
    try {
      const raw = await getRawBody({ req } as Parameters<typeof getRawBody>[0], MAX_BYTES);
      res.statusCode = 200;
      res.end(JSON.stringify({ received: raw.length }));
    } catch (err) {
      const { message, statusCode } = err as Error & { statusCode?: number };
      res.statusCode = statusCode === 413 ? 413 : 400;
      res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
    }
  }

  async function post(payloadBytes: number, options: { declareLength?: boolean } = {}): Promise<Outcome> {
    const server = http.createServer(reply);

    try {
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const { port } = server.address() as AddressInfo;

      return await new Promise<Outcome>((resolve) => {
        const payload = Buffer.alloc(payloadBytes, 'x');
        const req = http.request(
          {
            port,
            method: 'POST',
            path: '/api/ai-llm/v1/chat/completions',
            headers: options.declareLength === false ? {} : { 'Content-Length': String(payload.length) },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode, body }));
          },
        );
        req.on('error', (err: NodeJS.ErrnoException) => resolve({ body: '', clientError: err.code }));
        req.end(payload);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('answers an oversized body with a readable 413 rather than resetting the connection', async () => {
    const response = await post(200 * 1024);

    expect(response.clientError).toBeUndefined();
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body).error.message).toContain('too large');
  });

  it('reports 413 for a chunked upload that only exceeds the cap mid-stream', async () => {
    const response = await post(64 * 1024, { declareLength: false });

    expect(response.clientError).toBeUndefined();
    expect(response.status).toBe(413);
  });

  it('returns the exact bytes for a body within the limit', async () => {
    const response = await post(512);

    expect(response.clientError).toBeUndefined();
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).received).toBe(512);
  });

  it('accepts a body sitting exactly on the cap', async () => {
    const response = await post(MAX_BYTES);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).received).toBe(MAX_BYTES);
  });
});

describe('AI API multimodal content block validation', () => {
  const wrap = (content: unknown) => [{ role: 'user', content }];

  it('accepts plain string content and well-formed text/image_url blocks', () => {
    expect(findContentBlockProblem(wrap('Hello'))).toBeUndefined();
    expect(
      findContentBlockProblem(
        wrap([
          { type: 'text', text: 'What is in this picture?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
        ]),
      ),
    ).toBeUndefined();
  });

  it('accepts a bare string image_url but rewrites it to the object form every provider converts', () => {
    const block = { type: 'image_url', image_url: 'https://example.com/a.png' };

    expect(findContentBlockProblem(wrap([block]))).toBeUndefined();
    // `isOpenAIDataBlock` requires `image_url` to be an object, so the string
    // form would otherwise reach the provider unconverted.
    expect(normalizeMessageContent([block])).toEqual([
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ]);
  });

  it('leaves the object form and plain text blocks untouched', () => {
    const blocks = [
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ];

    expect(normalizeMessageContent(blocks)).toEqual(blocks);
    expect(normalizeMessageContent('plain')).toBe('plain');
  });

  it('rejects base64 payloads that match the grammar but cannot be decoded', () => {
    // Each of these passes LangChain's regex and then throws inside `atob`,
    // which used to surface as an HTTP 500.
    for (const payload of ['A===', 'A=', 'AAAAA', 'AAAA=']) {
      const problem = findContentBlockProblem(
        wrap([{ type: 'image_url', image_url: { url: `data:image/png;base64,${payload}` } }]),
      );

      expect(problem, payload).toBeDefined();
      expect(problem?.reason, payload).toContain('not decodable');
    }
  });

  it('still accepts correctly padded base64 payloads', () => {
    for (const payload of ['QUJD', 'QQ==', 'QUI=', 'iVBORw0KGgo=']) {
      expect(
        findContentBlockProblem(wrap([{ type: 'image_url', image_url: { url: `data:image/png;base64,${payload}` } }])),
        payload,
      ).toBeUndefined();
    }
  });

  it('rejects an unsupported block type and names it', () => {
    const problem = findContentBlockProblem([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'file', file: { file_data: 'data:application/pdf;base64,JVBERi0=' } }] },
    ]);

    expect(problem?.index).toBe(1);
    expect(problem?.reason).toContain("'file' is not supported");
  });

  it('rejects a text block with no text payload', () => {
    expect(findContentBlockProblem(wrap([{ type: 'text' }]))?.reason).toContain("requires a string 'text' field");
  });

  it('rejects an image_url block with no url', () => {
    expect(findContentBlockProblem(wrap([{ type: 'image_url' }]))?.reason).toContain(
      "requires a non-empty 'image_url.url'",
    );
    expect(findContentBlockProblem(wrap([{ type: 'image_url', image_url: { url: '' } }]))?.reason).toContain(
      "requires a non-empty 'image_url.url'",
    );
  });

  it('rejects a non-image data URL that the provider would treat as an image', () => {
    const problem = findContentBlockProblem(
      wrap([{ type: 'image_url', image_url: { url: 'data:application/pdf;base64,JVBERi0=' } }]),
    );

    expect(problem?.reason).toContain('application/pdf');
    expect(problem?.reason).toContain('not an image');
  });

  it('rejects a malformed base64 data URL instead of letting the adapter throw a 500', () => {
    for (const url of [
      'data:image/png;base64,iVBORw0 KGgo=',
      'data:image/png;base64,iVBORw0-KGgo=',
      'data:image/png,notbase64',
      'data:image/svg+xml;base64,PHN2Zz4=',
    ]) {
      const problem = findContentBlockProblem(wrap([{ type: 'image_url', image_url: { url } }]));
      expect(problem, url).toBeDefined();
    }
  });

  it('rejects a non-http(s) URL protocol', () => {
    expect(
      findContentBlockProblem(wrap([{ type: 'image_url', image_url: { url: 'ftp://example.com/a.png' } }]))?.reason,
    ).toContain("protocol 'ftp:'");
    expect(
      findContentBlockProblem(wrap([{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }]))?.reason,
    ).toContain("protocol 'file:'");
  });

  it('rejects a garbage url string', () => {
    expect(findContentBlockProblem(wrap([{ type: 'image_url', image_url: { url: 'not a url' } }]))?.reason).toContain(
      'not a valid URL',
    );
  });

  it('rejects a block that is not an object or has no type', () => {
    expect(findContentBlockProblem(wrap([42]))?.reason).toContain('must be an object');
    expect(findContentBlockProblem(wrap([{ text: 'no type field' }]))?.reason).toContain("requires a 'type' field");
  });

  it('ignores messages whose content is not an array', () => {
    expect(findContentBlockProblem([{ role: 'assistant', content: null }, { role: 'tool' }])).toBeUndefined();
  });
});

/**
 * `findContentBlockProblem` only inspects array content, so these malformed
 * messages used to reach `messages.some((m) => m.role === ...)` — a TypeError
 * reported as HTTP 500 — or died inside LangChain with MESSAGE_COERCION_FAILURE.
 */
describe('AI API message schema validation', () => {
  it('rejects a non-object message instead of throwing on m.role', () => {
    expect(findMessageProblem([null])?.reason).toContain('must be an object');
    expect(findMessageProblem([null])?.index).toBe(0);
    expect(findMessageProblem(['hello'])?.reason).toContain('must be an object');
    expect(findMessageProblem([42])?.reason).toContain('must be an object');
  });

  it('names the offending index', () => {
    const problem = findMessageProblem([{ role: 'user', content: 'ok' }, null]);

    expect(problem?.index).toBe(1);
  });

  it('rejects a missing or unsupported role before LangChain coerces it', () => {
    expect(findMessageProblem([{ content: 'no role' }])?.reason).toContain("requires a string 'role'");
    expect(findMessageProblem([{ role: 'function', content: 'x' }])?.reason).toContain(
      "role 'function' is not supported",
    );
    expect(findMessageProblem([{ role: 'moderator', content: 'x' }])?.reason).toContain(
      "role 'moderator' is not supported",
    );
  });

  it('accepts every role LangChain can coerce', () => {
    for (const role of ['system', 'developer', 'user', 'human', 'assistant', 'ai']) {
      expect(findMessageProblem([{ role, content: 'hi' }]), role).toBeUndefined();
    }
    expect(findMessageProblem([{ role: 'tool', content: 'out', tool_call_id: 'call_1' }])).toBeUndefined();
  });

  it('requires tool_call_id on a tool message', () => {
    expect(findMessageProblem([{ role: 'tool', content: 'out' }])?.reason).toContain(
      "requires a string 'tool_call_id'",
    );
  });

  it('requires content unless an assistant turn only carries tool_calls', () => {
    expect(findMessageProblem([{ role: 'user' }])?.reason).toContain("requires a 'content' field");
    expect(findMessageProblem([{ role: 'assistant', content: null }])?.reason).toContain("requires a 'content' field");
    expect(
      findMessageProblem([{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: {} }] }]),
    ).toBeUndefined();
  });

  it('rejects a content value that is neither string nor array', () => {
    expect(findMessageProblem([{ role: 'user', content: 42 }])?.reason).toContain('must be a string or an array');
    expect(findMessageProblem([{ role: 'user', content: { text: 'x' } }])?.reason).toContain(
      'must be a string or an array',
    );
  });

  it('accepts a well-formed multimodal conversation', () => {
    expect(
      findMessageProblem([
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: [{ type: 'text', text: 'What is this?' }] },
      ]),
    ).toBeUndefined();
  });
});
