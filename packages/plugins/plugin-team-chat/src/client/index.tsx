import { Plugin } from '@nocobase/client';
import React from 'react';

// Lazy-load for code splitting
const ChatPage = React.lazy(() => import('./components/ChatPage'));
const ChatSettings = React.lazy(() => import('./components/ChatSettings'));
const MeetingAdmin = React.lazy(() => import('./components/MeetingAdmin'));

/**
 * PluginTeamChatClient — Full chat + meeting experience inside NocoBase.
 *
 * Registers:
 * 1. /chat route — main chat page (with embedded Meeting Manager for users)
 * 2. Settings: Team Chat config
 * 3. Settings: Meeting Management (admin dashboard for controlling all meetings)
 */
export class PluginTeamChatClient extends Plugin {
  async load() {
    // Register main chat route (includes embedded Meeting Manager for users)
    this.app.router.add('team-chat', {
      path: '/chat',
      Component: 'ChatPage',
    });

    // Register the ChatPage component
    this.app.addComponent('ChatPage', ChatPage);

    // Register settings sub-pages under comm-suite
    this.app.pluginSettingsManager.add('comm-suite.team-chat', {
      title: this.t('Team Chat'),
      Component: ChatSettings,
      aclSnippet: 'pm.plugin-team-chat',
    });

    // Admin-only Meeting Management dashboard
    this.app.pluginSettingsManager.add('comm-suite.meetings', {
      title: this.t('Meeting Management'),
      Component: MeetingAdmin,
      aclSnippet: 'pm.plugin-team-chat.meetings',
    });
  }
}

export default PluginTeamChatClient;
