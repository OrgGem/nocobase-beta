import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { redirectLegacyNextAppLocation } from './hubRouteContract';

export const HubLegacyRedirect = () => {
  const location = useLocation();
  return <Navigate replace to={redirectLegacyNextAppLocation(location.pathname, location.search, location.hash)} />;
};

export default HubLegacyRedirect;
