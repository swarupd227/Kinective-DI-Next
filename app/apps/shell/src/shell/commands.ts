// Slash commands (spec 6.15). The session lists the ones the user's class permits (FE-EXP-131).
export const SLASH_HELP: Record<string, { hint: string; routedTo: string }> = {
  '/ask': { hint: 'Ask a data question', routedTo: 'Analytics Q&A' },
  '/brief': { hint: 'A briefing on what changed', routedTo: 'DI Concierge' },
  '/help': { hint: 'What DI can do for you', routedTo: 'DI Concierge' },
  '/report': { hint: 'Find, run or build a report', routedTo: 'Report Builder' },
  '/table': { hint: 'Open a table or view in the workspace', routedTo: 'Workspace' },
  '/query': { hint: 'Open Queries with an SQL draft', routedTo: 'SQL Query View' },
  '/member': { hint: 'Open a member 360', routedTo: 'Relationship' },
  '/customer': { hint: 'Open a customer 360', routedTo: 'Relationship' },
  '/refer': { hint: 'Start a referral', routedTo: 'Referral' },
  '/workflow': { hint: 'Open a workflow inbox or start a COM', routedTo: 'Workspace' },
  '/log': { hint: 'Create or review a data log', routedTo: 'Workspace' },
  '/user': { hint: 'Administer users', routedTo: 'Admin' },
};
