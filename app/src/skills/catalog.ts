import type { Manifest } from './types'

const BUI_RULE =
  'When a comparison, metric, chart, code sample, form or timeline would be clearer as a component, ' +
  'include exactly one fenced ```bui block with JSON: ' +
  '{"v":1,"blocks":[{"type":"table","columns":["A","B"],"rows":[["1","2"]]}]}. ' +
  'Charts: {"type":"chart","chart":"bar|line|area|pie|donut","categories":["A","B"],"series":[{"name":"n","points":[1,2]}]} — every series carries exactly one point per category. ' +
  'Allowed types: text, table, code, metric, form, timeline, worker, chart. Keep prose outside the fence.'

export const CATALOG: Manifest[] = [
  {
    id: 'concise',
    kind: 'skill',
    name: 'Concise',
    description: 'Short answers. No preamble, no restating the question.',
    version: '1.0.0',
    capabilities: ['chat'],
    instructions:
      'Answer in as few words as clarity allows. No preamble, no restating the question, no summary of what you are about to do.',
  },
  {
    id: 'table-first',
    kind: 'skill',
    name: 'Table-first',
    description: 'Comparisons become sortable tables instead of paragraphs.',
    version: '1.0.0',
    capabilities: ['chat'],
    instructions: `Prefer a table over prose whenever two or more things are compared. ${BUI_RULE}`,
  },
  {
    id: 'chart-first',
    kind: 'skill',
    name: 'Chart-first',
    description: 'Quantities and trends become charts instead of paragraphs.',
    version: '1.0.0',
    capabilities: ['chat'],
    instructions: `Prefer a chart over prose whenever magnitudes, trends or shares matter more than exact values. Bar compares magnitudes, line and area show trends, pie and donut show shares of a whole. ${BUI_RULE}`,
  },
  {
    id: 'cite',
    kind: 'skill',
    name: 'Cite sources',
    description: 'Factual claims carry a Markdown link to the source.',
    version: '1.0.0',
    capabilities: ['chat'],
    instructions:
      'When you make a factual claim that has a public source, cite it as a Markdown link naming the page. Never invent a source; if you cannot verify it, say so.',
  },
  {
    id: 'researcher',
    kind: 'sub-agent',
    name: 'Researcher',
    description: 'Runs a focused research pass in-flow and returns a short brief.',
    version: '1.0.0',
    capabilities: ['chat'],
    budget: { maxTurns: 1, maxTokens: 1200, maxMs: 30_000 },
    instructions:
      'You are a researcher. Investigate the request, separate facts from assumptions, and return a short brief: findings first, then open questions. Cite links where possible. Never invent a source.',
  },
  {
    id: 'critic',
    kind: 'sub-agent',
    name: 'Critic',
    description: 'Reviews the last answer for errors and unsupported claims.',
    version: '1.0.0',
    capabilities: ['chat'],
    budget: { maxTurns: 1, maxTokens: 800, maxMs: 20_000 },
    instructions:
      'You are a critic. Review the supplied answer for factual errors, missing constraints and unsupported claims. Return at most five bullet points, strongest first. If it is sound, say so in one line.',
  },
  {
    id: 'export-markdown',
    kind: 'plugin',
    name: 'Markdown export',
    description: 'Writes the current room to a Markdown file beside the app.',
    version: '1.0.0',
    capabilities: ['files'],
    handler: 'export-markdown',
  },
]
