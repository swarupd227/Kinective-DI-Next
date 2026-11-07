// The custom-mapping expression language: what it turns into, and what it refuses.
import { describe, expect, it } from 'vitest';
import { compileMapExpr, MapExprError } from '../src/mapExpr.ts';

const scope = { aliases: { a: 'ACCOUNT', n: 'NAME' }, tables: ['ACCOUNT', 'NAME', 'LOAN', 'ACCOUNTTRACKING'], columns: { ACCOUNT: ['ACCOUNTNUMBER', 'CLOSEDATE', 'TYPE'], NAME: ['FIRST', 'LAST'], LOAN: ['PARENTACCOUNT', 'CLOSEDATE', 'BALANCE'], ACCOUNTTRACKING: ['PARENTACCOUNT', 'TYPE', 'USERCHAR1'] } };
const sql = (e: string) => compileMapExpr(e, scope).sql;
const refuses = (e: string, why: RegExp) => expect(() => compileMapExpr(e, scope)).toThrow(why);

describe('custom mapping expressions', () => {
  it('writes the SQL for today’s DI examples itself', () => {
    expect(sql("IF(a.CLOSEDATE = '00000000', 0, 1)")).toBe("IF((a.CLOSEDATE = '00000000'), 0, 1)");
    expect(sql("COUNT_OF(LOAN, PARENTACCOUNT = a.ACCOUNTNUMBER AND CLOSEDATE = '00000000')")).toBe("(SELECT COUNT(*) FROM LOAN x0 WHERE ((x0.PARENTACCOUNT = a.ACCOUNTNUMBER) AND (x0.CLOSEDATE = '00000000')))");
    expect(sql('FIRST_OF(ACCOUNTTRACKING, USERCHAR1, PARENTACCOUNT = a.ACCOUNTNUMBER AND TYPE = 12)')).toBe('(SELECT x0.USERCHAR1 FROM ACCOUNTTRACKING x0 WHERE ((x0.PARENTACCOUNT = a.ACCOUNTNUMBER) AND (x0.TYPE = 12)) LIMIT 1)');
    expect(sql('SUM_OF(LOAN, BALANCE, PARENTACCOUNT = a.ACCOUNTNUMBER)')).toBe('(SELECT COALESCE(SUM(x0.BALANCE), 0) FROM LOAN x0 WHERE (x0.PARENTACCOUNT = a.ACCOUNTNUMBER))');
    expect(sql("a.TYPE IN (1, 2) AND n.LAST IS NOT NULL")).toBe('((a.TYPE IN (1, 2)) AND (n.LAST IS NOT NULL))');
    expect(compileMapExpr("UPPER(TRIM(n.FIRST))", scope).columns).toEqual(['NAME.FIRST']);
  });

  it('escapes text values', () => {
    expect(sql("IF(n.LAST = 'O''Brien', 'Y', 'N')")).toBe("IF((n.LAST = 'O''Brien'), 'Y', 'N')");
    expect(sql("n.LAST = 'a\\\\b'")).toBe("(n.LAST = 'a\\\\\\\\b')");
  });

  it('refuses anything that isn’t the language', () => {
    refuses("a.CLOSEDATE; DROP TABLE ACCOUNT", /“;” isn’t part/);
    refuses('a.CLOSEDATE -- comment', /Comments aren’t allowed/);
    refuses('a.CLOSEDATE /* x */', /Comments aren’t allowed/);
    refuses('SLEEP(10)', /isn’t a column|Unexpected|Say which table/);
    refuses('(SELECT 1)', /Say which table/);
    refuses('`ACCOUNT`.x', /isn’t part/);
    refuses('LOAD_FILE(a.TYPE)', /Say which table|Unexpected/);
    refuses("x.SECRET = 1", /isn’t one of this mapping’s tables/);
    refuses('a.PASSWORD', /ACCOUNT has no column PASSWORD/);
    refuses('COUNT_OF(MYSQL_USER, TYPE = 1)', /isn’t a table this mapping can read/);
    refuses('COUNT_OF(LOAN, COUNT_OF(LOAN, BALANCE > 0) > 0)', /inside another lookup/);
    refuses("IF(a.TYPE = 1, 'Y')", /IF takes 3 values/);
    refuses('CLOSEDATE', /Say which table/);
    refuses("'unclosed", /closing quote/);
    refuses('a.TYPE '.repeat(80), /at most 400 characters/);
    expect(() => compileMapExpr('a.TYPE =', scope)).toThrow(MapExprError);
  });
});
