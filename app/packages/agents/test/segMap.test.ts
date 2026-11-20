// @vitest-environment node
// DI's SEG map (DI parity, SEG Management): branches, SEGs and prospects over a heatmap of where
// members live, all placed from the institution's own geography, and directions to a company.
import { describe, expect, it } from 'vitest';
import { validateBlock, type Block, type ChartBlock } from '@dinext/block-schemas';
import { GeographyService } from '@dinext/di-core';
import { tenantPool, warehouseAvailable } from '@dinext/tenant-db';
import { buildOption } from '../../blocks/src/chart/buildOption.ts';
import { prospectingModule } from '../src/growth.ts';
import { segModule } from '../src/moreModules.ts';

describe('routing the map', () => {
  const seg = segModule({} as never, () => '2026-10-25', {} as GeographyService);
  const prs = prospectingModule({} as never, ['Acme HR'], ['Lead'], () => '2026-10-25');
  it('sends the map and directions to SEG Development, not Prospecting', () => {
    for (const q of ['Show the SEG and prospect map', 'Map our SEGs and prospects', 'Show a heatmap of where our members live']) {
      expect(seg.request.test(q), q).toBe(true);
      expect((seg.plan(q, {} as never) as { tool?: string }).tool, q).toBe('seg_map');
    }
    expect(prs.request.test('Show the SEG and prospect map')).toBe(false);
    expect(prs.request.test('Show my open prospects')).toBe(true);
    expect(seg.request.test('Directions to Acme HR')).toBe(true);
    expect(seg.plan('Directions to Acme HR', {} as never)).toEqual({ tool: 'seg_directions', args: { company: 'Acme HR' } });
    expect(seg.plan('How do I get to Riverside Schools?', {} as never)).toEqual({ tool: 'seg_directions', args: { company: 'Riverside Schools' } });
  });
});

const DB = 'dinext_t_test_cu';
const up = await warehouseAvailable(DB).then((ok) => ok && tenantPool(DB).query('SELECT 1 FROM cen_address_map LIMIT 1').then(() => true, () => false));
describe.skipIf(!up)('the SEG map against the warehouse', () => {
  const pool = tenantPool(DB);
  const geo = new GeographyService(pool);
  const ctx = { user: { id: 'user:1', name: 'Test', title: 'CEO' }, modules: ['seg'], runId: 'R-segmap', threadId: 't' };

  it('places every branch, SEG and prospect in the members’ own market', async () => {
    const m = (await geo.marketMap())!;
    expect(m.branches.length).toBe(6);
    expect(m.companies.filter((c) => c.kind === 'SEG').length).toBe(30);
    expect(m.companies.filter((c) => c.kind === 'Prospect').length).toBe(60);
    const lats = m.density.map((c) => c.lat);
    const [lo, hi] = [Math.min(...lats) - 0.1, Math.max(...lats) + 0.1];
    for (const p of [...m.branches, ...m.companies]) expect(p.lat > lo && p.lat < hi, `${p.name} at ${p.lat}`).toBe(true);
    // A branch limited purview sees its own branch.
    expect((await geo.marketMap(['Westport']))!.branches.map((b) => b.name)).toEqual(['Westport']);
  });

  it('draws a valid map block that the chart turns into four layers', async () => {
    const seg = segModule({} as never, () => '2026-10-25', geo);
    const view = (await seg.tools.find((t) => t.name === 'seg_map')!.run({} as never, ctx as never)) as { text: string; blocks: Block[] };
    expect(view.text).toMatch(/\*\*30 SEGs\*\* and \*\*60 prospects\*\* across 6 branches/);
    const block = view.blocks[0]!;
    expect(validateBlock(block).ok, JSON.stringify(validateBlock(block))).toBe(true);
    const option = buildOption(block as ChartBlock, { palette: ['#111', '#222', '#333', '#444'], text: '#000', muted: '#666', grid: '#ddd', surface: '#fff', border: '#ccc', fontFamily: 'sans-serif' } as never, true, { width: 640 }) as { series: { name: string; silent: boolean; data: { value: number[] }[] }[]; xAxis: { min: number; max: number } };
    expect(option.series.map((s) => [s.name, s.silent])).toEqual([['Members', true], ['SEGs', false], ['Prospects', false], ['Branches', false]]);
    expect(option.series[1]!.data.length).toBe(30);
    for (const s of option.series) for (const d of s.data) expect(d.value[0]! >= option.xAxis.min && d.value[0]! <= option.xAxis.max).toBe(true);
  });

  it('gives directions to a company from its branch', async () => {
    const seg = segModule({} as never, () => '2026-10-25', geo);
    const run = seg.tools.find((t) => t.name === 'seg_directions')!.run;
    const name = (await geo.marketMap())!.companies.find((c) => c.kind === 'SEG' && c.branch)!;
    const r = (await run({ company: name.name } as never, ctx as never)) as { text: string };
    expect(r.text).toMatch(new RegExp(`^\\[Directions from ${name.branch} to ${name.name}\\]\\(https://www\\.google\\.com/maps/dir/\\?api=1&origin=-?\\d+\\.\\d{5},-?\\d+\\.\\d{5}&destination=`));
    expect(((await run({ company: 'Flux Capacitor Co' } as never, ctx as never)) as { text: string }).text).toContain('no SEG or prospect called');
  });
});
