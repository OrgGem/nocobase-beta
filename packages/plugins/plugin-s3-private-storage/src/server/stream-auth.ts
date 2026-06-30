type StreamAuthContext = {
  state: {
    currentUser?: unknown;
  };
  throw(status: number, message: string): void;
};

export function assertStreamAuthenticated(ctx: StreamAuthContext) {
  if (!ctx.state.currentUser) {
    ctx.throw(401, 'Unauthenticated');
    return false;
  }

  return true;
}
