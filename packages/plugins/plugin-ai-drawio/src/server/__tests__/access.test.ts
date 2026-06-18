import { describe, expect, it } from 'vitest';
import {
  buildAccessibleDiagramFilter,
  canManageDiagram,
  canReadDiagram,
  canWriteDiagramContent,
  canWriteDiagramContent,
  getDiagramAccessLevel,
  getDiagramAgentAccess,
  hasAnyRole,
  normalizeAgents,
  normalizeRoles,
  sameId,
  type DiagramAccessContext,
} from '../actions/access';

const baseAccess = (over: Partial<DiagramAccessContext> = {}): DiagramAccessContext => ({
  userId: undefined,
  userRoles: [],
  isAdmin: false,
  hasUser: false,
  isAgentRun: false,
  agentUsername: undefined,
  agentRoles: [],
  ...over,
});

describe('access helpers', () => {
  it('sameId compares loosely by string', () => {
    expect(sameId(1, '1')).toBe(true);
    expect(sameId('a', 'a')).toBe(true);
    expect(sameId(null, null)).toBe(false);
    expect(sameId(1, 2)).toBe(false);
  });

  it('normalizeRoles / normalizeAgents drop empties and coerce to string', () => {
    expect(normalizeRoles(['a', '', null, 1])).toEqual(['a', '1']);
    expect(normalizeAgents(['bot', undefined, ''])).toEqual(['bot']);
    expect(normalizeRoles('nope' as any)).toEqual([]);
  });

  it('hasAnyRole intersects allowed and current roles', () => {
    expect(hasAnyRole(['admin', 'editor'], ['editor'])).toBe(true);
    expect(hasAnyRole(['admin'], ['viewer'])).toBe(false);
    expect(hasAnyRole([], ['viewer'])).toBe(false);
  });

  it('defaults access level to BASIC and agent access to inherit', () => {
    expect(getDiagramAccessLevel({})).toBe('BASIC');
    expect(getDiagramAccessLevel({ accessLevel: 'PUBLIC' })).toBe('PUBLIC');
    expect(getDiagramAccessLevel({ accessLevel: 'bogus' })).toBe('BASIC');
    expect(getDiagramAgentAccess({})).toBe('inherit');
    expect(getDiagramAgentAccess({ agentAccess: 'none' })).toBe('none');
    expect(getDiagramAgentAccess({ agentAccess: 'bogus' })).toBe('inherit');
  });
});

describe('canReadDiagram — user dimension', () => {
  it('admin reads anything', () => {
    const access = baseAccess({ isAdmin: true, hasUser: true, userId: '1' });
    expect(canReadDiagram(access, { accessLevel: 'BASIC', createdById: '999' })).toBe(true);
  });

  it('PUBLIC is readable by any logged-in user', () => {
    const access = baseAccess({ userId: '7', hasUser: true });
    expect(canReadDiagram(access, { accessLevel: 'PUBLIC' })).toBe(true);
  });

  it('BASIC is readable only by its owner', () => {
    const owner = baseAccess({ userId: '7', hasUser: true });
    const other = baseAccess({ userId: '8', hasUser: true });
    const row = { accessLevel: 'BASIC', createdById: '7' };
    expect(canReadDiagram(owner, row)).toBe(true);
    expect(canReadDiagram(other, row)).toBe(false);
  });

  it('SHARED is readable by a holder of an allowed role', () => {
    const editor = baseAccess({ userId: '7', hasUser: true, userRoles: ['editor'] });
    const viewer = baseAccess({ userId: '8', hasUser: true, userRoles: ['viewer'] });
    const row = { accessLevel: 'SHARED', allowedRoles: ['editor'] };
    expect(canReadDiagram(editor, row)).toBe(true);
    expect(canReadDiagram(viewer, row)).toBe(false);
  });
});

describe('canManageDiagram — user dimension', () => {
  it('PUBLIC is not manageable by non-admins', () => {
    const user = baseAccess({ userId: '7', hasUser: true });
    expect(canManageDiagram(user, { accessLevel: 'PUBLIC' })).toBe(false);
  });

  it('BASIC owner can manage; others cannot', () => {
    const owner = baseAccess({ userId: '7', hasUser: true });
    const other = baseAccess({ userId: '8', hasUser: true });
    const row = { accessLevel: 'BASIC', createdById: '7' };
    expect(canManageDiagram(owner, row)).toBe(true);
    expect(canManageDiagram(other, row)).toBe(false);
  });

  it('SHARED role holder can manage', () => {
    const editor = baseAccess({ userId: '7', hasUser: true, userRoles: ['editor'] });
    expect(canManageDiagram(editor, { accessLevel: 'SHARED', allowedRoles: ['editor'] })).toBe(true);
  });

  it('BASIC with no owner is manageable only by admins', () => {
    const user = baseAccess({ userId: '7', hasUser: true });
    const admin = baseAccess({ userId: '1', hasUser: true, isAdmin: true });
    const orphan = { accessLevel: 'BASIC', createdById: null };
    expect(canManageDiagram(user, orphan)).toBe(false);
    expect(canManageDiagram(admin, orphan)).toBe(true);
  });
});

describe('canWriteDiagramContent — in-place canvas edits (saveXml)', () => {
  // The AI Employee's display/edit/append tools persist through saveXml in the
  // triggering user's browser session. Content-write must therefore equal read
  // access so the agent can edit whatever canvas the user has open in place.
  it('any reader can write content, even a non-owner of a PUBLIC diagram', () => {
    const reader = baseAccess({ userId: '8', hasUser: true });
    expect(canWriteDiagramContent(reader, { accessLevel: 'PUBLIC' })).toBe(true);
    // ...but a non-owner still cannot *manage* the policy of a PUBLIC diagram
    expect(canManageDiagram(reader, { accessLevel: 'PUBLIC' })).toBe(false);
  });

  it('SHARED role holder can write content', () => {
    const editor = baseAccess({ userId: '7', hasUser: true, userRoles: ['editor'] });
    const outsider = baseAccess({ userId: '9', hasUser: true, userRoles: ['guest'] });
    const row = { accessLevel: 'SHARED', allowedRoles: ['editor'] };
    expect(canWriteDiagramContent(editor, row)).toBe(true);
    expect(canWriteDiagramContent(outsider, row)).toBe(false);
  });

  it('BASIC content is writable only by its owner', () => {
    const owner = baseAccess({ userId: '7', hasUser: true });
    const other = baseAccess({ userId: '8', hasUser: true });
    const row = { accessLevel: 'BASIC', createdById: '7' };
    expect(canWriteDiagramContent(owner, row)).toBe(true);
    expect(canWriteDiagramContent(other, row)).toBe(false);
  });

  it('agentAccess none blocks content writes during an agent run', () => {
    const agent = baseAccess({ isAgentRun: true, agentUsername: 'bot', hasUser: true, userId: '7' });
    expect(canWriteDiagramContent(agent, { accessLevel: 'PUBLIC', agentAccess: 'none' })).toBe(false);
  });
});

describe('agent dimension — intersection with user', () => {
  it('agentAccess none blocks every agent run', () => {
    const agent = baseAccess({ isAgentRun: true, agentUsername: 'bot', hasUser: true, userId: '7' });
    const row = { accessLevel: 'PUBLIC', agentAccess: 'none' };
    expect(canReadDiagram(agent, row)).toBe(false);
    expect(canManageDiagram(agent, row)).toBe(false);
  });

  it('inherit lets the agent ride on the user gate', () => {
    const agentAsOwner = baseAccess({
      isAgentRun: true,
      agentUsername: 'bot',
      hasUser: true,
      userId: '7',
    });
    const agentAsOther = baseAccess({
      isAgentRun: true,
      agentUsername: 'bot',
      hasUser: true,
      userId: '8',
    });
    const row = { accessLevel: 'BASIC', createdById: '7', agentAccess: 'inherit' };
    // owner-triggered run passes, non-owner-triggered run fails (user gate)
    expect(canReadDiagram(agentAsOwner, row)).toBe(true);
    expect(canReadDiagram(agentAsOther, row)).toBe(false);
  });

  it('explicit requires the agent to be named or hold a listed role', () => {
    const named = baseAccess({
      isAgentRun: true,
      agentUsername: 'bot',
      hasUser: true,
      userId: '7',
    });
    const unnamed = baseAccess({
      isAgentRun: true,
      agentUsername: 'other-bot',
      hasUser: true,
      userId: '7',
    });
    const row = {
      accessLevel: 'PUBLIC',
      agentAccess: 'explicit',
      allowedAgents: ['bot'],
    };
    expect(canReadDiagram(named, row)).toBe(true);
    expect(canReadDiagram(unnamed, row)).toBe(false);
  });

  it('explicit honors agent roles', () => {
    const roleAgent = baseAccess({
      isAgentRun: true,
      agentUsername: 'bot',
      agentRoles: ['kbReader'],
      hasUser: true,
      userId: '7',
    });
    const row = {
      accessLevel: 'PUBLIC',
      agentAccess: 'explicit',
      allowedRoles: ['kbReader'],
    };
    expect(canReadDiagram(roleAgent, row)).toBe(true);
  });

  it('explicit agent still blocked when the triggering user fails the user gate', () => {
    const agent = baseAccess({
      isAgentRun: true,
      agentUsername: 'bot',
      hasUser: true,
      userId: '8',
    });
    const row = {
      accessLevel: 'BASIC',
      createdById: '7',
      agentAccess: 'explicit',
      allowedAgents: ['bot'],
    };
    // agent gate passes, but user gate (BASIC owner=7, user=8) fails → blocked
    expect(canReadDiagram(agent, row)).toBe(false);
  });

  it('autonomous agent (no user) is gated by the agent dimension alone', () => {
    const autoInherit = baseAccess({ isAgentRun: true, agentUsername: 'bot', hasUser: false });
    const autoNamed = baseAccess({ isAgentRun: true, agentUsername: 'bot', hasUser: false });
    expect(canReadDiagram(autoInherit, { accessLevel: 'BASIC', createdById: '7', agentAccess: 'inherit' })).toBe(true);
    expect(
      canReadDiagram(autoNamed, {
        accessLevel: 'BASIC',
        createdById: '7',
        agentAccess: 'explicit',
        allowedAgents: ['bot'],
      }),
    ).toBe(true);
    expect(
      canReadDiagram(autoNamed, {
        accessLevel: 'BASIC',
        createdById: '7',
        agentAccess: 'explicit',
        allowedAgents: ['someone-else'],
      }),
    ).toBe(false);
  });
});

describe('buildAccessibleDiagramFilter', () => {
  it('admin gets no user constraint', () => {
    const admin = baseAccess({ isAdmin: true, hasUser: true, userId: '1' });
    expect(buildAccessibleDiagramFilter(admin)).toEqual({});
  });

  it('member filter covers PUBLIC, owned BASIC, and SHARED roles', () => {
    const member = baseAccess({ userId: '7', hasUser: true, userRoles: ['editor'] });
    const filter = buildAccessibleDiagramFilter(member);
    expect(filter).toEqual({
      $or: [
        { accessLevel: 'PUBLIC' },
        { accessLevel: 'BASIC', createdById: '7' },
        { accessLevel: 'SHARED', 'allowedRoles.$anyOf': ['editor'] },
      ],
    });
  });

  it('agent run adds the agent clause and respects ids', () => {
    const agent = baseAccess({
      userId: '7',
      hasUser: true,
      isAgentRun: true,
      agentUsername: 'bot',
    });
    const filter = buildAccessibleDiagramFilter(agent, ['d1', 'd2']);
    expect(filter.$and).toBeDefined();
    expect(filter.$and).toContainEqual({ id: { $in: ['d1', 'd2'] } });
    expect(filter.$and).toContainEqual({
      $or: [
        { agentAccess: 'inherit' },
        { $and: [{ agentAccess: 'explicit' }, { $or: [{ allowedAgents: { $anyOf: ['bot'] } }] }] },
      ],
    });
  });

  it('autonomous agent filter omits the user clause', () => {
    const auto = baseAccess({ isAgentRun: true, agentUsername: 'bot', hasUser: false });
    const filter = buildAccessibleDiagramFilter(auto);
    // only the agent clause remains
    expect(filter).toEqual({
      $or: [
        { agentAccess: 'inherit' },
        { $and: [{ agentAccess: 'explicit' }, { $or: [{ allowedAgents: { $anyOf: ['bot'] } }] }] },
      ],
    });
  });
});
