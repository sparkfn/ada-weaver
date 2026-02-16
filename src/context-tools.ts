import { tool } from 'langchain';
import { z } from 'zod';
import type { IssueContextRepository, IssueContextEntryType } from './issue-context-repository.js';

const VALID_ENTRY_TYPES: IssueContextEntryType[] = [
  'issuer_brief', 'architect_plan', 'coder_plan', 'review_feedback', 'ci_result', 'outcome',
];

/**
 * Create the save_issue_context tool.
 * Agent name is baked in at creation time — the tool knows who's calling it.
 */
export function createSaveContextTool(
  contextRepo: IssueContextRepository,
  repoId: number,
  issueNumber: number,
  processId: string | null,
  agentName: string,
) {
  return tool(
    async (input: { entry_type: string; content: string; files_touched?: string[]; iteration?: number }) => {
      try {
        const entry = await contextRepo.addEntry({
          repoId,
          issueNumber,
          processId,
          entryType: input.entry_type as IssueContextEntryType,
          agent: agentName,
          content: input.content,
          filesTouched: input.files_touched ?? [],
          iteration: input.iteration ?? 0,
        });
        return JSON.stringify({ saved: true, id: entry.id, entry_type: input.entry_type });
      } catch (error) {
        return `Error saving context: ${error}`;
      }
    },
    {
      name: 'save_issue_context',
      description: 'Save a context entry for this issue. Other agents can read it to understand what you did. Use this to record your analysis, plan, feedback, or outcome.',
      schema: z.object({
        entry_type: z.enum(VALID_ENTRY_TYPES as [string, ...string[]])
          .describe('Type of context entry: issuer_brief, architect_plan, coder_plan, review_feedback, ci_result, or outcome'),
        content: z.string().describe('The content to save (your analysis, plan, feedback, etc.)'),
        files_touched: z.array(z.string()).optional().describe('File paths relevant to this entry'),
        iteration: z.number().optional().describe('Current review-fix iteration number (0-based)'),
      }),
    },
  );
}

/**
 * Create the get_issue_context tool.
 * Scoped to the current processId (within-run only).
 */
export function createGetContextTool(
  contextRepo: IssueContextRepository,
  processId: string,
) {
  return tool(
    async (input: { entry_type?: string }) => {
      try {
        const entries = await contextRepo.getEntriesForProcess(processId);
        const filtered = input.entry_type
          ? entries.filter(e => e.entryType === input.entry_type)
          : entries;

        if (filtered.length === 0) {
          return JSON.stringify({ entries: [], message: 'No context entries found for this run.' });
        }

        const result = filtered.map(e => ({
          entry_type: e.entryType,
          agent: e.agent,
          content: e.content,
          files_touched: e.filesTouched,
          iteration: e.iteration,
          created_at: e.createdAt,
        }));

        return JSON.stringify({ entries: result });
      } catch (error) {
        return `Error reading context: ${error}`;
      }
    },
    {
      name: 'get_issue_context',
      description: "Read shared context entries from this pipeline run. See what other agents have written — the issuer's brief, the architect's plan, the coder's plan, or the reviewer's feedback. Omit entry_type to get all entries.",
      schema: z.object({
        entry_type: z.enum(VALID_ENTRY_TYPES as [string, ...string[]])
          .optional()
          .describe('Optional filter: only return entries of this type'),
      }),
    },
  );
}

/**
 * Create the search_past_issues tool.
 * For cross-run learning — find how past issues touching the same files were resolved.
 * Only given to Issuer and Architect (not Coder/Reviewer).
 */
export function createSearchPastIssuesTool(
  contextRepo: IssueContextRepository,
  repoId: number,
  currentIssueNumber: number,
) {
  return tool(
    async (input: { files?: string[]; limit?: number }) => {
      try {
        let results;

        if (input.files && input.files.length > 0) {
          results = await contextRepo.searchByFiles(repoId, input.files, {
            limit: input.limit ?? 10,
            excludeIssueNumber: currentIssueNumber,
          });
        } else {
          results = await contextRepo.searchRecent(repoId, {
            limit: input.limit ?? 10,
            excludeIssueNumber: currentIssueNumber,
          });
        }

        if (results.length === 0) {
          return JSON.stringify({ past_issues: [], message: 'No past issues found.' });
        }

        // Group by issue number for readability
        const grouped = new Map<number, typeof results>();
        for (const r of results) {
          const group = grouped.get(r.issueNumber);
          if (group) {
            group.push(r);
          } else {
            grouped.set(r.issueNumber, [r]);
          }
        }

        const pastIssues = Array.from(grouped.entries()).map(([issueNum, entries]) => ({
          issue_number: issueNum,
          entries: entries.map(e => ({
            entry_type: e.entryType,
            agent: e.agent,
            content: e.content,
            files_touched: e.filesTouched,
            iteration: e.iteration,
          })),
        }));

        return JSON.stringify({ past_issues: pastIssues });
      } catch (error) {
        return `Error searching past issues: ${error}`;
      }
    },
    {
      name: 'search_past_issues',
      description: 'Search for past issues that touched the same files or recent outcomes. Use this to learn from how similar issues were resolved. Pass file paths for overlap search, or omit for recent outcomes.',
      schema: z.object({
        files: z.array(z.string()).optional().describe('File paths to search for overlap with past issues'),
        limit: z.number().optional().describe('Maximum number of results (default 10)'),
      }),
    },
  );
}
