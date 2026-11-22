import type { Analysis, RequestRecord, RunInfo } from '../types.js';
import { renderHtml } from './html.js';
import { renderMarkdown } from './markdown.js';
import { buildModel, type ReportModel } from './model.js';

export interface Reports {
  model: ReportModel;
  html: string;
  markdown: string;
}

/** Renders both reports. Pure: the same inputs always give the same bytes. */
export function renderReports(run: RunInfo, analysis: Analysis, records: RequestRecord[], seal: string): Reports {
  const model = buildModel(run, analysis, seal);
  const urls = new Map(records.map((r) => [r.id, r.url]));
  return {
    model,
    html: renderHtml({ ...model, requestUrl: (id) => urls.get(id) }),
    markdown: renderMarkdown(model),
  };
}
