"""
ESP alignment, phase 0: the per-table mapping from ESP's data model to DI-Next's.

    python -I app/docs/esp-alignment/build_mapping.py <path to esp-data-dictionary.md>

Writes mapping.csv (every ESP table), mapping.md (the business layer, by status) and columns.md (column
by column for the hub tables) beside this file. DI-Next keeps its own table names (cdm_*, hist_*, ...);
ESP names are lineage. The script reads DI-Next's CREATE TABLE statements from app/packages/*/src and
fails if the mapping names a DI table or column that does not exist, so the docs can't drift from the
schema unnoticed. The dictionary itself is not committed: it is ESP's, and is passed in.
"""
import csv, os, re, sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(os.path.dirname(HERE))

# ---- Reading the two models -------------------------------------------------------------------------

def read_esp(path):
    tables, app, cur = [], None, None
    for line in open(path, encoding='utf-8'):
        line = line.rstrip('\n')
        m = re.match(r'^# App: (\S+)', line)
        if m:
            app = m.group(1); continue
        m = re.match(r'^## `([^`]+)`', line)
        if m:
            cur = {'app': app, 'name': m.group(1), 'cols': []}; tables.append(cur); continue
        m = re.match(r'^\| `([^`]+)` \| ([^|]*)\| ([^|]*)\| ([^|]*)\| (.*)\|$', line)
        if m and cur is not None:
            cur['cols'].append({'c': m.group(1), 't': m.group(2).strip(), 'fk': m.group(4).strip(), 'd': m.group(5).strip()})
    return tables


def read_di():
    """DI-Next tables and columns, from every CREATE TABLE in app/packages/*/src."""
    di = {}
    for pkg in os.listdir(os.path.join(APP, 'packages')):
        src = os.path.join(APP, 'packages', pkg, 'src')
        for root, _, files in os.walk(src):
            for f in files:
                if not f.endswith('.ts'):
                    continue
                text = open(os.path.join(root, f), encoding='utf-8').read()
                for m in re.finditer(r'CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)`?\s*\(', text):
                    depth, i, start = 1, m.end(), m.end()
                    while depth and i < len(text):
                        depth += {'(': 1, ')': -1}.get(text[i], 0); i += 1
                    body, parts, d, cur = text[start:i - 1], [], 0, ''
                    for ch in body:
                        d += {'(': 1, ')': -1}.get(ch, 0)
                        if ch == ',' and d == 0:
                            parts.append(cur); cur = ''
                        else:
                            cur += ch
                    parts.append(cur)
                    cols = [p.split()[0].strip('`') for p in (x.strip() for x in parts) if p and not re.match(r'(KEY|PRIMARY|UNIQUE|INDEX|CONSTRAINT|FOREIGN)\b', p, re.I)]
                    di.setdefault(m.group(1), set()).update(cols)
    return di

# ---- Layers -----------------------------------------------------------------------------------------

LAYERS = {
    'Core-system feed': ['prodigy', 'corelation', 'symitar', 'dna', 'fis', 'fics'],
    'Third-party feed': ['meridianLink', 'syncOne', 'encompass', 'lendingPad', 'cudl', 'transunion', 'mahalo', 'glia', 'genesys', 'hubspot', 'salesForce', 'zoho', 'marketo', 'qualtrics', 'amelia', 'clutch', 'synapsys', 'mbfs', 'midwest', 'unitedone', 'wasatchpeaks', 'iQQ', 'microsoftGraph', 'tykmaLaser', 'naics', 'geoLocator', 'address', 'ldap', 'powerBI'],
    'Business and analytics': ['finBI', 'crm', 'finProfit', 'stats', 'seg', 'marketing', 'referrals', 'onboarding', 'comCenter', 'brm', 'accounting', 'external', 'recommendations', 'snapshot', 'fhlb', 'census'],
    'Work and people': ['empManager', 'timeTracking', 'calendar', 'knowledge', 'learn', 'ats', 'contact', 'email', 'dashboard'],
    'ESP platform': ['core', 'reportViewer', 'tableManager', 'oauth', 'api', 'adminManager', 'timeMachine', 'dbDiff', 'test', 'tplTest', 'demo', 'features', 'appServer', 'updateServer', 'heatwave', 'llm', 'queryBrowser', 'chartBuilder', 'fileUploader', 'fileManager', 'scheduler', 'security', 'systemLogs', 'errorTracker', 'obfuscator', 'recordValidator', 'extSync', 'dataCenter', 'matchFinder', 'mobileSite', 'ocr', 'fillablePdf', 'unregistered'],
}
LAYER_OF = {a: layer for layer, apps in LAYERS.items() for a in apps}
LAYER_NOTE = {
    'Core-system feed': 'Raw extract from one core vendor; ESP maps it into its business layer. DI maps a tenant’s core through Core mapping (src_mapping, src_column_map).',
    'Third-party feed': 'Integration feed; DI takes it as a source only when a feature needs it.',
    'Work and people': 'Staff tools; DI has its own where it needs them (to-dos, calendar, time).',
    'ESP platform': 'ESP’s own framework (forms, formats, report engine, security, audit); DI-Next has its own platform.',
}
# Third-party feeds DI already draws on, or would.
FEED_NOTE = {
    'meridianLink': 'Loan origination system: the source for cdm_loan_application and the pipeline.',
    'syncOne': 'Loan origination system: the source for cdm_loan_application and the pipeline.',
    'encompass': 'Mortgage origination system: the source for mortgage applications.',
    'lendingPad': 'Mortgage origination system: the source for mortgage applications.',
    'cudl': 'Indirect lending network: the source for ind_dealer and ind_dealer_month.',
    'transunion': 'Credit bureau: the source for cdm_credit_score_history soft pulls.',
    'mahalo': 'Digital banking: the source for cdm_digital_usage and cdm_party_activity.',
}


def kind_of(t):
    """What a business-layer table is, by its shape and name."""
    n = t['name']
    if not t['cols']: return 'Generated (no columns)'
    if re.search(r'^esp_tm_|_changes$', n): return 'Audit copy'
    if re.search(r'sort(data|types|stack)?$|sort(data|types)?_', n): return 'Sort hierarchy'
    if 'repform_' in n or 'dashboardform_' in n or re.search(r'form$', n): return 'Report or screen form'
    if n.endswith('_link') or n.endswith('_dd') or n.endswith('_backup'): return 'Link or drill table'
    if 'unittest' in n or 'test2024' in n: return 'Test fixture'
    if re.search(r'types?$|statuses$|status$|levels$|tiers$|bins$|windows$|options$|settings$|priorities$|categories$|stages$', n): return 'Lookup'
    return 'Entity or fact'

# ---- Table rules: first match wins. (pattern, status, DI tables, phase, note) ----------------------
# Phases: 1 accounts, households and customer details; 2 charge-offs, recoveries and insider loans;
# 3 FHLB collateral; 4 account-level monthly snapshots; 5 services and channel activity;
# 6 account and member profitability; 7 member applications, alerts, deduplication, marketing touches;
# 8 business relationships and census geography.

C, P, M, N = 'Covered', 'Partial', 'Missing', 'Not needed'
RULES = [
    # Loans, shares, products, cards
    (r'^esp_finbi_loandata$', C, 'cdm_loan, cdm_loan_terms, cdm_account_holding, cdm_account_origination, cdm_account_product, cdm_account_owner, cdm_loan_detail', None, 'Every column but the application link and who decided it, which the demo seed builds apart from the loan book (see columns.md).'),
    (r'^esp_finbi_sharedata$', C, 'cdm_deposit_account, cdm_deposit_terms, cdm_account_holding, cdm_account_origination, cdm_account_product, cdm_account_owner', None, 'Accounts, numbers, opening deposit, certificate terms, renewal and servicing overrides (see columns.md).'),
    (r'^esp_finbi_loanproddata$', C, 'cdm_loan_product, cdm_product_detail', None, 'Name, category, 5300 line, and details: description, rate type, used auto, cross-sell group, conversation starter (phase 1b).'),
    (r'^esp_finbi_shareproddata$', C, 'cdm_deposit_product, cdm_product_detail, cdm_dividend_tier', None, 'Name, category, rates, and details: term, membership share, cross-sell group, tiers (phase 1b).'),
    (r'^esp_finbi_(carddata|cardproddata)$', C, 'cdm_card, cdm_card_terms, cdm_card_product', None, 'Cards with their product, expiry and linked accounts (phase 1b).'),
    (r'^esp_finbi_productdata$', C, 'cdm_loan_product, cdm_deposit_product', None, 'DI keeps loan and deposit products apart.'),
    (r'^esp_finbi_(miscdata|miscproddata)$', C, 'cdm_misc_account, cdm_misc_product', None, 'Safe deposit boxes under the member\u2019s account (phase 1b).'),
    (r'^esp_finbi_(loandatacustomerdatalink|sharedatacustomerdatalink|loandatacustomerdatauniquematch|sharedatacustomerdatauniquematch)$', C, 'cdm_account_owner', None, 'Who is on each loan and share (ESP step 5).'),
    (r'^esp_finbi_(loantransdata|loantranscodedata|loantranssourcedata|loantransfeedata)$', C, 'cdm_loan_transaction, cdm_transaction_code', None, 'Loan transactions (ESP step 4).'),
    (r'^esp_finbi_(sharetransdata|sharetranscodedata|sharetranssourcedata|sharetransfeedata)$', C, 'cdm_share_transaction, cdm_transaction_code', None, 'Share transactions (ESP step 4).'),
    (r'^esp_finbi_(voided|reversed)(loan|share)transdata$', M, '', 4, 'Voided and reversed transactions; DI keeps posted transactions only.'),
    (r'^esp_finbi_(loan|share)transtimes$', N, '', None, 'Time-of-day bins for teller reports.'),
    (r'^esp_finbi_(loan|share)(billpay|mobile|online|debit|directdeposit)transdata$', P, 'cdm_loan_transaction, cdm_share_transaction, cdm_party_activity', 5, 'DI has the channel on each transaction and 90-day counts per person; per-account channel tables are phase 5.'),
    (r'^esp_finbi_(account|loan|deposit)service(prod)?data(_overrides)?$', P, 'cdm_digital_usage', 5, 'DI knows which services a person uses; services per account are phase 5.'),
    (r'^esp_finbi_(loan|share)balancehistymd$', M, '', 4, 'Daily balance history per account.'),
    (r'^esp_finbi_(loandata_ym|depositdata_ym|loansbymember_ym|depositsbymember_ym)$', M, 'hist_loan_month, hist_deposit_month', 4, 'Account-level month-end snapshots; DI keeps month-end totals by branch and category today.'),
    (r'^esp_finbi_(account)?new(loan|deposit)balance_ymd$', P, 'hist_loan_month, cdm_loan', 4, 'New balances by day; DI has new loans by month and branch.'),
    (r'^esp_finbi_(loan|share)shomebranchoverrides$|^esp_finbi_(loans|deposits)homebranchoverrides$', C, 'cdm_account_holding', None, 'cdm_account_holding.servicing_branch_id (phase 1b).'),
    (r'^esp_finbi_dealer$', C, 'ind_dealer', None, 'Indirect dealers.'),
    (r'^esp_finbi_lienposition$', M, '', 3, 'Lien position, for collateral eligibility.'),
    (r'^esp_finbi_loanparticipationtypes$', M, '', 3, 'Participation types.'),
    (r'^esp_finbi_(loanratetypes|loanstructuretypes)$', C, 'cdm_loan_terms', None, 'Fixed or variable rate; amortizing or line (phase 1).'),
    (r'^esp_finbi_loandelinquencybins$', C, 'hist_loan_dq_month', None, 'DI’s delinquency buckets.'),
    (r'^esp_finbi_dividendtiers$', C, 'cdm_dividend_tier', None, 'Rates by balance tier, from what accounts earn (phase 1b).'),
    (r'^esp_finbi_crosssellgroups$', C, 'cdm_cross_sell_group, cdm_product_detail', None, 'Product groups for cross-sell counts (phase 1b).'),
    (r'^esp_finbi_(maturingcdlookaheadwindows|maturingcdsreportoptions)$', C, 'cdm_deposit_account', None, 'Maturing certificates come from maturity_date.'),
    (r'^esp_finbi_(loancustomermatchtypes|sharecustomermatchtypes|accountcustomermatchtypes)$', C, 'cdm_account_owner', None, 'Owner roles (cdm_account_owner.role).'),
    (r'^esp_finbi_(loanprodreportmetrics|shareprodreportmetrics)$', N, '', None, 'Report column settings.'),
    # Charge-offs, recoveries, insider loans
    (r'^esp_finbi_(loanchargeoffs|loanrecoveries|depositchargeoffs|depositrecoveries)$', P, 'cdm_loan, cr_value', 2, 'Charge-off date per loan and net charge-offs from the Call Report; amounts and recoveries per account are phase 2.'),
    (r'^esp_finbi_external(loan|deposit)(chargeoffs|recoveries)$', M, 'ofc_loan', 2, 'Charge-offs and recoveries on off-core accounts.'),
    (r'^esp_finbi_(officialownedloans|employeeowned_loans)$', M, '', 2, 'Insider and employee loans: Regulation O (banks), NCUA 701.21(d) (credit unions).'),
    # Off-core
    (r'^esp_finbi_externalloandata$|^esp_finbi_externalloansources$', C, 'ofc_loan, ofc_feed, ofc_load', None, 'Off-core loans and their sources.'),
    (r'^esp_finbi_externaldepositsources$', M, '', 2, 'Off-core deposit sources.'),
    # Applications
    (r'^esp_finbi_(loanappdata|loanapphistory|loanapplicants|loanappstatuses|loanapplicanttypes)$', C, 'cdm_loan_application, cdm_loan_app_status_history, mod_lap_status_map', None, 'Loan applications and their status history.'),
    (r'^esp_finbi_loanappsby_applicant_product$', C, 'cdm_loan_application', None, 'A reporting view over applications.'),
    (r'^esp_finbi_(memberappdata|memberapphistory|memberapplicants|memberappstatuses|memberapplicanttypes)$', M, '', 7, 'Membership (account-opening) applications.'),
    (r'^esp_finbi_mortgageoriginations$', C, 'cdm_loan', None, ''),
    # Call Report
    (r'^esp_finbi_(5300|call)', C, 'cr_form, cr_line, cr_value, cr_gl_account, cr_check, cr_explanation, cr_adjustment, cr_loan_override, cr_chargeoff_upload', None, 'NCUA 5300 and FFIEC 051.'),
    (r'^esp_finbi_pastcall', C, 'cr_value, cr_check', None, 'Prior filings and their validation.'),
    (r'^esp_crm_callreport_customerdata$', C, 'cdm_party, cr_value', None, 'Member counts for the 5300.'),
    (r'^esp_finbi_systemmappings$', C, 'src_mapping, src_column_map', None, 'How a source fills a figure; DI’s Core mapping.'),
    (r'^esp_finbi_(replaysyncstatus)$', N, '', None, 'ESP build bookkeeping.'),
    # GL and budget
    (r'^esp_finbi_(gl|glaccount|glsub|glloghist|glranges|glreport|glcategories|glentries|gleliminations|glfinalized|glhistorical|gldata|glsortdatamap|glloangroupadj|gl1_gl2)', C, 'gl_account, gl_balance_day, gl_balance_month, gl_journal, gl_company, gl_cost_center, gl_budget, cr_gl_account', None, 'General ledger, balances by period, maps and budgets.'),
    (r'^esp_finbi_budgetupload$', C, 'fin_budget, gl_budget', None, ''),
    (r'^esp_finbi_loanprod2histymgoals$|^esp_finbi_loanamounthistory$', C, 'fin_loan_goal', None, ''),
    (r'^esp_finbi_reportlineformatting$', N, '', None, 'Report formatting.'),
    (r'^esp_finbi_(campaign(loan|deposit)prod(sort)?match)$', C, 'cmp_campaign, cmp_attribution', None, 'Which products a campaign counts.'),
    (r'^esp_finbi_(trans|transcode|transfee|transpurpose|transsource)', C, 'cdm_transaction_code', None, ''),
    (r'^esp_finbi_tellerreporttransactiontimebins$', N, '', None, ''),
    (r'^esp_finbi_producttypes$', C, 'cdm_loan_product, cdm_deposit_product', None, 'Product kinds as category columns.'),
    # CRM
    (r'^esp_crm_customerdata$', C, 'cdm_party, cdm_party_detail, cdm_party_address, cdm_party_profile, cdm_party_contact, cdm_digital_usage, cdm_party_activity, rwd_member', None, 'Identity, numbers, names, contact, address, language, deceased and opt-out; counts are derived (see columns.md).'),
    (r'^esp_crm_customerdata_ym$|^esp_crm_accountdata_ym$|^esp_crm_householdstats_ym$', M, 'hist_member_month, hist_party_month', 4, 'Month-end snapshots per person, account and household.'),
    (r'^esp_crm_accountdata$', C, 'cdm_account, cdm_account_holding, cdm_account_owner', None, 'The account (membership or account number) between a person and their loans and shares (phase 1).'),
    (r'^esp_crm_(accountdatacustomerdatalink|customerdatatoaccountdatamatch|accountcustomermatchtypes)$', C, 'cdm_account_owner, cdm_account_holding', None, 'Who is on each account, and which account each loan and share sits under.'),
    (r'^esp_crm_(accounttypes|customertypes|customerlinktype)$', C, 'cdm_account', None, 'Individual, joint, trust or business (cdm_account.account_type).'),
    (r'^esp_crm_tintypes$', C, 'cdm_party_detail', None, 'Taxpayer ID type (cdm_party_detail.tin_type).'),
    (r'^esp_crm_householddata$|^esp_crm_householdaddresses$', C, 'cdm_household, cdm_party_address', None, 'Households and their address (phase 1).'),
    (r'^esp_crm_householdstatsreportcolumns$', N, '', None, 'Report column settings.'),
    (r'^esp_crm_creditscorehistory$|^esp_crm_customerscoretypes$', C, 'cdm_credit_score_history', None, 'ESP step 1.'),
    (r'^esp_crm_customerinteraction', C, 'cdm_interaction, rm_interaction_log', None, ''),
    (r'^esp_crm_customersurveys$', C, 'cdm_survey', None, ''),
    (r'^esp_crm_customersegment$', C, 'cdm_party', None, 'segment_code.'),
    (r'^esp_crm_(accountsuggestions|accountsuggestionlog|manualaccountsuggestions|manualsuggestionsproducts|suggestionlog_|suggestionproducttypedata|suggestionssettings|accountsuggestions_sources)', C, 'cdm_suggestion, cdm_suggestion_history, mod_suggestion_decline', None, 'Products to suggest and what came of them.'),
    (r'^esp_crm_accounteventpreds$|^esp_crm_attritionseverity$', C, 'cdm_attrition_score, ml_score', None, 'Model predictions.'),
    (r'^esp_crm_(accountalerts|customeralerts|accountalerttypes|customeralerttypes|customerdataalertcolumns)$', M, 'cdm_account_comment', 7, 'Alerts on accounts and people; DI has the core’s warning codes as comments.'),
    (r'^esp_crm_customerdeduplication', M, '', 7, 'Possible duplicate people across sources.'),
    (r'^esp_crm_fraudaccountdata$', C, 'fraud_case', None, ''),
    (r'^esp_crm_(mobilelogins|onlinelogins)$', P, 'cdm_digital_usage, cdm_party_activity', 5, 'Last login and 90-day counts per person; each login is phase 5.'),
    (r'^esp_crm_(competitors|currentsituations)$', C, 'cdm_party_profile', None, 'Life events, needs and products at other institutions.'),
    (r'^esp_crm_(customersearch|customerselector|customersources|producttypetables)$', N, '', None, 'Search and screen settings.'),
    (r'^esp_crm_restrictionlevels$', N, '', None, 'ESP row security; DI uses purview.'),
    # Profitability
    (r'^esp_finprofit_(loan_ym|deposit_ym|account_ym|customer_ym|profit_histym)$', M, '', 6, 'Profit per loan, deposit, account and member by month.'),
    (r'^esp_finprofit_(loancostprofit|depositcostprofit|loantranscost|deposittranscost|typedata|predictedloanloss|shareinteresthist|sharetransinterest)$', P, 'fin_budget, cr_value', 6, 'DI computes product profitability from the Call Report and budget; the cost model per account is phase 6.'),
    (r'^esp_finprofit_(fhlbrates|fhlbproductmap)$', M, 'mkt_rate_month', 6, 'Funds transfer pricing rates; DI has market rates by month.'),
    (r'^esp_finprofit_settings$', N, '', None, ''),
    # FHLB
    (r'^esp_fhlb_', M, '', 3, 'FHLB collateral eligibility; DI estimates capacity at typical lendable values today.'),
    # Workflows: ESP's com framework; DI keeps the ESP names here.
    (r'^(allcom|esp_mergedcomlines)', C, 'esp_com_items, esp_com_lines, esp_com_queues', None, 'The com framework DI’s referrals, onboarding and prospects run on.'),
    (r'^esp_(com|comcenter_)', C, 'esp_com_items, esp_com_lines, esp_com_queues, wf_definition', None, 'Com states, routing, follow-ups and priorities.'),
    (r'^esp_referrals_', C, 'esp_com_items, esp_com_lines, mod_ref_types', None, 'Referrals.'),
    (r'^esp_onboarding_onboardingcom', C, 'onb_rule, onb_task, onb_message, onb_checklist, onb_subscription', None, 'Onboarding touch points.'),
    (r'^esp_onboarding_', C, 'cdm_party_profile, onb_rule', None, 'Onboarding questionnaire lists.'),
    (r'^esp_seg_prospect', C, 'prs_prospect, prs_stage, prs_activity, prs_disposition', None, 'Prospects.'),
    (r'^esp_seg_(bus1_hist|interactions|interactiontypes|sponsorships|sponsorshiptypes|segdashboard|eventtypes|touchtypes|allactions)', C, 'seg_company, seg_contact, seg_event, seg_interaction, seg_sponsorship, seg_bd_goal', None, 'Select employee groups.'),
    # Marketing
    (r'^esp_marketing_(campaigndata|campaignactions|campaigngantt|campaign(loan|share)prodhist|touchtypedata)', C, 'cmp_campaign, cmp_audience, cmp_attribution, cmp_platform_metric', None, 'Campaigns and their results.'),
    (r'^esp_marketing_', M, 'cmp_attribution', 7, 'Touches per account, person, address and email.'),
    # Models
    (r'^esp_stats', C, 'ml_model, ml_score, ml_drift', None, 'Model definitions, runs and predictions; DI keeps its models in ml_*.'),
    (r'^esp_recommendations_', C, 'cdm_suggestion', None, ''),
    # Business relationships and census
    (r'^esp_brm_|^loc_internalinvoicerecipients$', M, '', 8, 'Business members: businesses, locations, contacts, statement and invoice recipients.'),
    (r'^esp_census_', M, '', 8, 'Census geography (state, county, tract, block, ZCTA) for CRA and fair lending maps.'),
    # Small apps
    (r'^esp_accounting_', N, '', None, 'An internal bookkeeping app, separate from the GL DI reports on.'),
    (r'^esp_external', N, '', None, 'ESP’s outbound email links and posts.'),
    (r'^esp_snapshot_', N, '', None, 'ESP build snapshots.'),
]

# ---- Column maps for the hub tables: column -> (status, DI target or note, phase) ---------------------
D = 'Derived'
LOAN_SHARE_DERIVED = [
    (r'^(numRecent|sumRecent)', D, 'cdm_loan_transaction, cdm_share_transaction, cdm_party_activity (counted)', None),
    (r'(?i)(billpay|mobilebanking|onlinebanking|debitcard|directdeposit|phonebanking)lastdate$', D, 'cdm_loan_transaction.channel, cdm_share_transaction.channel, cdm_digital_usage', None),
    (r'^lastActivityDate$', D, 'cdm_loan_transaction.posted, cdm_share_transaction.posted', None),
    (r'^(uuid|id_int|app|restrictionLevel|timeStamp)$', N, 'ESP keys and row security; DI uses purview', None),
]
COLUMNS = {
    'esp_finbi_loandata': ('cdm_loan', {
        'id': (C, 'cdm_loan.loan_id'), 'loanID': (C, 'cdm_account_holding.suffix'), 'accountID': (C, 'cdm_account_holding.account_number'),
        'loanAccountNumber': (C, 'cdm_account_holding.holding_number'), 'source': (C, 'cdm_loan.source'), 'external': (C, 'cdm_loan.source'),
        'loanProdID': (C, 'cdm_account_product.product_id'), 'appID': (N, 'The demo seed builds applications apart from the loan book; a core feed links them'),
        'balance': (C, 'cdm_loan.balance'), 'originalAmount': (C, 'cdm_loan.original_amount'), 'originalFundingDate': (C, 'cdm_loan.open_date'),
        'openDate': (C, 'cdm_loan.open_date'), 'closeDate': (C, 'cdm_loan.close_date'), 'openBranch': (C, 'cdm_loan.branch_id'),
        'originatingBranch': (C, 'cdm_account_origination.originating_branch_id'), 'openedByEmpNumber': (C, 'cdm_account_origination.opened_by_employee_id'),
        'originatingUser': (C, 'cdm_loan.officer_id'), 'associatedCustomers': (C, 'cdm_account_owner.party_id'), 'homeBranchOverride': (C, 'cdm_account_holding.servicing_branch_id'),
        'interestRate': (C, 'cdm_loan.rate'), 'apr': (C, 'cdm_loan_terms.apr'), 'loanTerm': (C, 'cdm_loan.term_months'), 'maturityDate': (C, 'cdm_loan_terms.maturity_date'),
        'daysDelinquent': (C, 'cdm_loan.days_delinquent'), 'chargeOffDate': (C, 'cdm_loan.charge_off_date'), 'chargeOffAmount': (M, 'Amount charged off', 2),
        'appCreditScore': (C, 'cdm_loan.credit_score'), 'appCreditScoreTypeID': (C, 'cdm_credit_score_history.score_type'),
        'avgRecentCreditScore': (D, 'cdm_credit_score_history.score'), 'maxRecentCreditScore': (D, 'cdm_credit_score_history.score'), 'minRecentCreditScore': (D, 'cdm_credit_score_history.score'),
        'recentCreditScoreDate': (D, 'cdm_credit_score_history.as_of'), 'recentCreditScoreTypeID': (D, 'cdm_credit_score_history.score_type'),
        'ltv': (C, 'cdm_loan.ltv'), 'loanLTV': (C, 'cdm_loan.ltv'), 'appDTI': (C, 'cdm_loan_terms.dti'),
        'call5300Category': (C, 'cdm_loan_product.reg_amount_code'), 'call5300CategoryOverride': (C, 'cr_loan_override.to_code'),
        'creditLimit': (C, 'cdm_loan_terms.credit_limit'), 'paymentAmount': (C, 'cdm_loan_terms.payment_amount'), 'paymentDueDate': (C, 'cdm_loan_terms.payment_due_date'),
        'paymentLastDate': (D, 'cdm_loan_transaction.posted'), 'amountPaid': (D, 'cdm_loan_transaction.principal, cdm_loan_transaction.interest'),
        'nextInterestRateChangeDate': (C, 'cdm_loan_terms.next_rate_change'), 'rateTypeOverride': (C, 'cdm_loan_terms.rate_type'), 'structureOverride': (C, 'cdm_loan_terms.structure'),
        'pmiPolicy': (C, 'cdm_loan_terms.pmi'), 'reserveAmount': (C, 'cdm_loan_terms.escrow_balance'), 'notes': (P, 'cdm_account_comment.text'),
        'dealerIntID': (C, 'cdm_loan_terms.dealer_id'), 'decisioningUserEmpNumber': (N, 'Comes with the application link; a core feed carries it'),
        'percentOwnership': (M, 'Share sold in a participation', 3), 'retainedBalance': (M, 'Balance kept after a participation', 3), 'participationTypeID': (M, 'Participation type', 3),
        'investorNumber': (M, 'Investor on a sold loan', 3), 'lienPositionID': (M, 'Lien position', 3), 'fhlbIneligibilityCause': (M, 'Why the loan can’t be pledged', 3),
        'fhlbIneligibiltyCauses': (M, 'Why the loan can’t be pledged', 3), 'fhlbCreditScore': (M, 'Score the FHLB uses', 3),
        'empOwned': (M, 'Employee loan', 2), 'officialOwned': (M, 'Insider loan (Regulation O, 701.21)', 2), 'allowedServices': (M, 'Services on the loan', 5),
    }),
    'esp_finbi_sharedata': ('cdm_deposit_account', {
        'id': (C, 'cdm_deposit_account.account_id'), 'shareID': (C, 'cdm_account_holding.suffix'), 'accountID': (C, 'cdm_account_holding.account_number'),
        'depositAccountNumber': (C, 'cdm_account_holding.holding_number'), 'shareProdID': (C, 'cdm_account_product.product_id'), 'balance': (C, 'cdm_deposit_account.balance'),
        'interestRate': (C, 'cdm_deposit_account.rate'), 'openDate': (C, 'cdm_deposit_account.open_date'), 'closeDate': (C, 'cdm_deposit_account.close_date'),
        'maturityDate': (C, 'cdm_deposit_account.maturity_date'), 'openBranch': (C, 'cdm_deposit_account.branch_id'), 'openedByEmpNumber': (C, 'cdm_account_origination.opened_by_employee_id'),
        'associatedCustomers': (C, 'cdm_account_owner.party_id'), 'homeBranchOverride': (C, 'cdm_account_holding.servicing_branch_id'), 'originalAmount': (C, 'cdm_deposit_terms.original_amount'),
        'autoRenew': (C, 'cdm_deposit_terms.auto_renew'), 'autoRenewAmount': (C, 'cdm_deposit_terms.auto_renew_amount'),
        'chargeOffAmount': (M, 'Overdrawn balance charged off', 2), 'chargeOffDate': (M, 'Overdrawn balance charge-off date', 2),
    }),
    'esp_crm_customerdata': ('cdm_party', {
        'id': (C, 'cdm_party.party_id'), 'memberNumber': (C, 'cdm_party_detail.member_number'), 'first': (C, 'cdm_party.first_name'), 'last': (C, 'cdm_party.last_name'),
        'birthDate': (C, 'cdm_party.birth_date'), 'orgDate': (C, 'cdm_party.join_date'), 'firstPrimaryOpenDate': (C, 'cdm_party.join_date'), 'curFirstPrimaryOpenDate': (C, 'cdm_party.join_date'),
        'homeBranch': (C, 'cdm_party.primary_branch_id'), 'segment': (C, 'cdm_party.segment_code'), 'householdID': (C, 'cdm_party.household_id'), 'householdHeadID': (C, 'cdm_household.head_party_id'),
        'closed': (C, 'cdm_membership_exit.party_id'), 'closeDate': (C, 'cdm_membership_exit.close_date'), 'lastCloseDate': (C, 'cdm_membership_exit.close_date'), 'lastPrimaryCloseDate': (C, 'cdm_membership_exit.close_date'),
        'email': (C, 'cdm_party_contact.email'), 'mobilePhone': (C, 'cdm_party_contact.phone'), 'homePhone': (C, 'cdm_party_detail.home_phone'), 'workPhone': (C, 'cdm_party_detail.work_phone'), 'workPhoneExtension': (C, 'cdm_party_detail.work_phone_ext'), 'altEmail': (C, 'cdm_party_detail.alt_email'),
        'street': (C, 'cdm_party_address.street'), 'street2': (C, 'cdm_party_address.street2'), 'city': (C, 'cdm_party_address.city'), 'state': (C, 'cdm_party_address.state'), 'zip': (C, 'cdm_party_address.zip'), 'baseZip': (C, 'cdm_party_address.zip'), 'normalizedStreet': (C, 'cdm_party_address.street'),
        'latitude': (M, 'Location, for maps', 8), 'longitude': (M, 'Location, for maps', 8),
        'middle': (C, 'cdm_party_detail.middle_name'), 'namePrefix': (C, 'cdm_party_detail.name_prefix'), 'nameSuffix': (C, 'cdm_party_detail.name_suffix'), 'suffix': (C, 'cdm_party_detail.name_suffix'), 'fullName': (D, 'cdm_party.first_name, cdm_party.last_name'), 'preferredName': (C, 'cdm_party_detail.preferred_name'),
        'type': (P, 'cdm_party.is_member, cdm_account.account_type'), 'tinType': (C, 'cdm_party_detail.tin_type'), 'deathDate': (C, 'cdm_party_detail.deceased_date'), 'language': (C, 'cdm_party_detail.language'),
        'marketingOptOut': (C, 'cdm_party_detail.marketing_opt_out'), 'eNotice': (C, 'cdm_account.e_notice'), 'estatements': (C, 'cdm_digital_usage.estatements_since'), 'estatementsEligible': (C, 'cdm_account.estatements_eligible'),
        'onlineBanking': (C, 'cdm_digital_usage.online_banking_since'), 'mobileBanking': (C, 'cdm_digital_usage.mobile_since'), 'billPay': (C, 'cdm_digital_usage.bill_pay_since'), 'directDeposit': (C, 'cdm_digital_usage.direct_deposit_status'),
        'debitCard': (D, 'cdm_card.kind'), 'phoneBanking': (M, 'Phone banking', 5), 'rewardsPoints': (C, 'rwd_member.points'), 'surveyScore': (D, 'cdm_survey.score'), 'lastSurveyDate': (D, 'cdm_survey.survey_date'),
        'lastSurveyPromoterScore': (D, 'cdm_survey.score'), 'lastSurveySatisfactionScore': (D, 'cdm_survey.score'), 'interactionLastDate': (D, 'cdm_interaction.occurred_at'), 'lastCorrespondenceDate': (D, 'cdm_interaction.occurred_at'),
        'openBranch': (C, 'cdm_party.primary_branch_id'), 'openEmpNumber': (C, 'cdm_account.opened_by_employee_id'), 'demoLikelihoodToAttrite': (C, 'cdm_attrition_score.score'), 'eligiblePromotions': (C, 'cdm_suggestion.product'),
        'custHasIndirect': (D, 'cdm_loan.is_indirect'), 'isCustOnlyIndirect': (D, 'cdm_loan.is_indirect'), 'notes': (P, 'cdm_account_comment.text'), 'primary': (C, 'cdm_account_owner.role'),
        'ssn': (N, 'DI never stores a full SSN'), 'encryptedTaxId': (N, 'DI never stores a full SSN'), 'taxIdEncrypted': (N, 'DI never stores a full SSN'), 'ssnLastFourDigits': (C, 'cdm_party_detail.ssn_last4'),
        'symitarSource': (N, 'Core-specific'),
    }),
    'esp_crm_accountdata': ('cdm_account', {
        'id': (C, 'cdm_account.account_number'), 'accountNumber': (C, 'cdm_account.account_number'), 'title': (C, 'cdm_account.title'), 'customerID': (C, 'cdm_account.primary_party_id'),
        'associatedCustomers': (C, 'cdm_account_owner.party_id'), 'type': (C, 'cdm_account.account_type'), 'homeBranch': (C, 'cdm_account.branch_id'), 'openBranch': (C, 'cdm_account.branch_id'),
        'openEmpNumber': (C, 'cdm_account.opened_by_employee_id'), 'openEmpsort2ID': (D, 'cdm_account.opened_by_employee_id, cdm_employee.branch_id, cdm_org_unit'), 'openDate': (C, 'cdm_account.open_date'), 'closeDate': (C, 'cdm_account.close_date'), 'closed': (C, 'cdm_account.close_date'),
        'onboardedDate': (D, 'onb_task'), 'lastOnboardingTime': (D, 'onb_task'), 'onboardingDays': (D, 'onb_task'), 'relationshipCode': (C, 'cdm_account.relationship_code'),
        'isBoardMember': (M, 'Board member on the account', 2), 'isRepPayee': (C, 'cdm_account.is_rep_payee'), 'isTrust': (C, 'cdm_account.account_type'), 'restrictAccess': (N, 'ESP row security'),
        'eNotice': (C, 'cdm_account.e_notice'), 'estatements': (C, 'cdm_account.estatements'), 'estatementsEligible': (C, 'cdm_account.estatements_eligible'), 'lastCheckingOpenDate': (D, 'cdm_deposit_account.open_date'),
        'acctHasIndirect': (D, 'cdm_loan.is_indirect'), 'isAcctOnlyIndirect': (D, 'cdm_loan.is_indirect'), 'orgDate': (C, 'cdm_account.open_date'), 'lastCorrespondenceDate': (D, 'cdm_interaction.occurred_at'),
        'onlineBanking': (D, 'cdm_digital_usage.online_banking_since'), 'mobileBanking': (D, 'cdm_digital_usage.mobile_since'), 'billPay': (D, 'cdm_digital_usage.bill_pay_since'), 'directDeposit': (D, 'cdm_digital_usage.direct_deposit_status'),
        'debitCard': (D, 'cdm_card.kind'), 'phoneBanking': (M, 'Phone banking', 5),
    }),
    'esp_crm_householddata': ('cdm_household', {
        'id': (C, 'cdm_household.household_id'), 'name': (C, 'cdm_household.name'), 'shortName': (C, 'cdm_household.name'), 'description': (N, 'Free text'),
        'houseHoldMembers': (C, 'cdm_household.members'), 'normalizedAddress': (C, 'cdm_household.street'), 'oldestAccountID': (D, 'cdm_account.open_date'), 'orgDate': (C, 'cdm_household.formed_date'),
        'closed': (D, 'cdm_membership_exit.party_id'), 'closeDate': (D, 'cdm_membership_exit.close_date'),
        'hasChecking': (D, 'cdm_deposit_account.deposit_category'), 'hasMoneyMarket': (D, 'cdm_deposit_account.deposit_category'), 'hasCertificate': (D, 'cdm_deposit_account.deposit_category'),
        'hasConsumerLoan': (D, 'cdm_loan.loan_category'), 'hasMortgage': (D, 'cdm_loan.loan_category'), 'hasCreditCard': (D, 'cdm_loan.loan_category'),
        'onlineBanking': (D, 'cdm_digital_usage.online_banking_since'), 'mobileBanking': (D, 'cdm_digital_usage.mobile_since'), 'debitCard': (D, 'cdm_card.kind'),
    }),
    'esp_finbi_loanproddata': ('cdm_loan_product', {
        'id': (C, 'cdm_loan_product.product_id'), 'name': (C, 'cdm_loan_product.name'), 'description': (C, 'cdm_product_detail.description'), 'active': (C, 'cdm_product_detail.active'),
        '5300Category': (C, 'cdm_loan_product.reg_amount_code'), 'creditCard': (C, 'cdm_loan_product.loan_category'), 'mortgage': (C, 'cdm_loan_product.loan_category'), 'homeEquity': (C, 'cdm_loan_product.loan_category'),
        'auto': (C, 'cdm_loan_product.loan_category'), 'consumer': (C, 'cdm_loan_product.loan_category'), 'commercial': (C, 'cdm_loan_product.loan_category'), 'signature': (C, 'cdm_loan_product.loan_category'), 'other': (C, 'cdm_loan_product.loan_category'),
        'usedAuto': (C, 'cdm_product_detail.used_auto'), 'indirect': (C, 'cdm_loan.is_indirect'), 'construction': (N, 'No construction lending in the demo products'), 'structure': (C, 'cdm_loan_product.revolving'), 'rateType': (C, 'cdm_product_detail.rate_type'),
        'crossSell': (C, 'cdm_product_detail.cross_sell_group'), 'crossSellGroup': (C, 'cdm_product_detail.cross_sell_group'), 'allowSuggestion': (C, 'cdm_suggestion.product'), 'referralType': (C, 'mod_ref_types'),
        'conversationStarters': (C, 'cdm_product_detail.conversation_starter'), 'fhlbsort1ID': (M, 'FHLB product group', 3), 'fhlbsort1Level': (M, 'FHLB product group', 3),
        'finprofitsort1ID': (M, 'Profitability group', 6), 'finprofitsort1Level': (M, 'Profitability group', 6), 'sort1ID': (C, 'cdm_loan_product.loan_category'), 'sort1Level': (C, 'cdm_loan_product.loan_category'),
        'sort2ID': (C, 'cdm_loan_product.loan_category'), 'sort2Level': (C, 'cdm_loan_product.loan_category'), 'print': (N, 'Report setting'), 'ignore': (N, 'Report setting'),
        'initialBalance': (N, 'Report setting'), 'initialCreditLimit': (N, 'Report setting'), 'newLoanAmountOverride': (N, 'Report setting'), 'conditionallyCancellable': (C, 'cdm_product_detail.conditionally_cancellable'),
        'allowedServices': (M, 'Services allowed on the product', 5),
    }),
    'esp_finbi_shareproddata': ('cdm_deposit_product', {
        'id': (C, 'cdm_deposit_product.product_id'), 'name': (C, 'cdm_deposit_product.name'), 'description': (C, 'cdm_product_detail.description'), 'active': (C, 'cdm_product_detail.active'),
        '5300Category': (C, 'cdm_deposit_product.deposit_category'), 'certificate': (C, 'cdm_deposit_product.deposit_category'), 'checking': (C, 'cdm_deposit_product.deposit_category'), 'ira': (C, 'cdm_deposit_product.deposit_category'),
        'savings': (C, 'cdm_deposit_product.deposit_category'), 'moneyMarket': (C, 'cdm_deposit_product.deposit_category'), 'commercial': (C, 'cdm_deposit_product.name'), 'cuPrimaryShare': (C, 'cdm_product_detail.membership_share'),
        'maturityFrequency': (C, 'cdm_product_detail.term_months'), 'maturityPeriod': (C, 'cdm_product_detail.term_months'), 'crossSell': (C, 'cdm_product_detail.cross_sell_group'), 'crossSellGroup': (C, 'cdm_product_detail.cross_sell_group'),
        'allowSuggestion': (C, 'cdm_suggestion.product'), 'referralType': (C, 'mod_ref_types'), 'conversationStarters': (C, 'cdm_product_detail.conversation_starter'),
        'finprofitsort1ID': (M, 'Profitability group', 6), 'finprofitsort1Level': (M, 'Profitability group', 6), 'sort1ID': (C, 'cdm_deposit_product.deposit_category'), 'sort1Level': (C, 'cdm_deposit_product.deposit_category'),
        'sort2ID': (C, 'cdm_deposit_product.deposit_category'), 'sort2Level': (C, 'cdm_deposit_product.deposit_category'), 'print': (N, 'Report setting'),
    }),
    'esp_finbi_carddata': ('cdm_card', {
        'id': (C, 'cdm_card.card_id'), 'cardNumber': (C, 'cdm_card.last4'), 'customerID': (C, 'cdm_card.party_id'), 'accountID': (C, 'cdm_card.account_id'), 'description': (C, 'cdm_card.kind'),
        'activationDate': (C, 'cdm_card.activated'), 'closeDate': (C, 'cdm_card.closed'), 'issueDate': (C, 'cdm_card.opened'), 'originalIssueDate': (C, 'cdm_card.opened'), 'expirationDate': (C, 'cdm_card_terms.expires'),
        'depositAccess': (C, 'cdm_card_terms.linked_accounts'), 'cardProdIntID': (C, 'cdm_card_terms.card_product_id'),
    }),
    'esp_crm_creditscorehistory': ('cdm_credit_score_history', {
        'customerIntID': (C, 'cdm_credit_score_history.party_id'), 'score': (C, 'cdm_credit_score_history.score'),
        'scoreDate': (C, 'cdm_credit_score_history.as_of'), 'typeIntID': (C, 'cdm_credit_score_history.score_type'),
    }),
}
COLUMN_DEFAULTS = {  # for columns a hub map doesn't name
    'esp_crm_customerdata': LOAN_SHARE_DERIVED + [(r'CrossSell', D, 'cdm_account_product, cdm_loan, cdm_deposit_account (counted)', None), (r'^(num|sum)(Open|Chargeoff|Pending|Recent|Estatement)', D, 'cdm_loan, cdm_deposit_account, cdm_loan_application (counted)', None)],
    'esp_crm_accountdata': LOAN_SHARE_DERIVED + [(r'CrossSell', D, 'cdm_account_product (counted)', None), (r'^(num|sum)', D, 'cdm_loan, cdm_deposit_account (counted)', None)],
    'esp_crm_householddata': LOAN_SHARE_DERIVED + [(r'CrossSell', D, 'cdm_account_product (counted)', None), (r'^(num|sum)', D, 'cdm_loan, cdm_deposit_account, cdm_loan_application (counted)', None)],
}
for k in ('esp_finbi_loandata', 'esp_finbi_sharedata', 'esp_finbi_loanproddata', 'esp_finbi_shareproddata', 'esp_finbi_carddata', 'esp_crm_creditscorehistory'):
    COLUMN_DEFAULTS[k] = LOAN_SHARE_DERIVED
SKIP_COLS = re.compile(r'^(espDev|espLastTplLoadTime|intID|esp_intID|esp_uuid|espLast\w*|espCreate\w*)$')

# ---- Build ------------------------------------------------------------------------------------------

def main(dictionary):
    esp, di = read_esp(dictionary), read_di()
    errors, rows = [], []

    def check(ref, where):
        """A DI reference: 'table', 'table.column' or a comma list of them, with optional notes in brackets."""
        for part in re.split(r',\s*', re.sub(r'\(.*?\)', '', ref)):
            part = part.strip()
            if not re.match(r'^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$', part):
                continue
            table, _, col = part.partition('.')
            if table not in di:
                errors.append(f'{where}: no DI table {table}')
            elif col and col not in di[table]:
                errors.append(f'{where}: no column {table}.{col}')

    for t in esp:
        layer = LAYER_OF.get(t['app'], '?')
        if layer == '?':
            errors.append(f"{t['name']}: app {t['app']} has no layer")
        row = {'app': t['app'], 'layer': layer, 'esp_table': t['name'], 'columns': len(t['cols']), 'kind': '', 'status': '', 'di_tables': '', 'phase': '', 'note': ''}
        if layer != 'Business and analytics':
            row.update(kind='', status='Not modeled', note=FEED_NOTE.get(t['app'], LAYER_NOTE[layer]))
        else:
            kind = kind_of(t)
            row['kind'] = kind
            if kind in ('Generated (no columns)', 'Audit copy', 'Report or screen form', 'Link or drill table', 'Test fixture'):
                row.update(status=N, note={'Generated (no columns)': 'Generated by ESP (no columns defined).', 'Audit copy': 'ESP time-machine audit copy.', 'Report or screen form': 'An ESP report or screen form.', 'Link or drill table': 'ESP many-to-many link or drill view.', 'Test fixture': 'ESP test data.'}[kind])
            elif kind == 'Sort hierarchy':
                row.update(status=N, note='An ESP picker tree; DI keeps groupings as columns (loan_category, deposit_category, gl_account groups, cdm_org_unit).')
            else:
                hit = next((r for r in RULES if re.search(r[0], t['name'])), None)
                if hit is None:
                    errors.append(f"{t['name']}: no rule ({kind})")
                else:
                    _, status, tables, phase, note = hit
                    check(tables, t['name'])
                    row.update(status=status, di_tables=tables, phase=phase or '', note=note)
        rows.append(row)

    # Column maps
    by_name = {t['name']: t for t in esp}
    col_rows = []
    for name, (target, explicit) in COLUMNS.items():
        t = by_name.get(name)
        if t is None:
            errors.append(f'{name}: not in the dictionary'); continue
        for c in t['cols']:
            if SKIP_COLS.match(c['c']):
                continue
            if c['c'] in explicit:
                v = explicit[c['c']]
                status, ref, phase = v[0], v[1], (v[2] if len(v) > 2 else None)
            else:
                d = next((d for d in COLUMN_DEFAULTS.get(name, []) if re.search(d[0], c['c'])), None)
                if d is None:
                    status, ref, phase = '?', '', None
                    errors.append(f"{name}.{c['c']}: no column mapping")
                else:
                    status, ref, phase = d[1], d[2], d[3]
            if status in (C, P, D):
                check(ref, f"{name}.{c['c']}")
            col_rows.append({'esp_table': name, 'di_table': target, 'esp_column': c['c'], 'type': c['t'], 'status': status, 'di_or_note': ref, 'phase': phase or '', 'esp_description': c['d']})
        for col in explicit:
            if col not in {c['c'] for c in t['cols']}:
                errors.append(f'{name}.{col}: mapped but not in the dictionary')

    if errors:
        print('\n'.join(sorted(set(errors))))
        sys.exit(f'{len(set(errors))} problems; nothing written.')

    write(rows, col_rows)


def write(rows, col_rows):
    with open(os.path.join(HERE, 'mapping.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    with open(os.path.join(HERE, 'columns.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=list(col_rows[0].keys())); w.writeheader(); w.writerows(col_rows)

    esc = lambda s: str(s).replace('|', '\\|')
    layers = Counter(r['layer'] for r in rows)
    biz = [r for r in rows if r['layer'] == 'Business and analytics']
    status = Counter(r['status'] for r in biz)
    real = [r for r in biz if r['kind'] in ('Entity or fact', 'Lookup')]
    out = ['# ESP to DI-Next: table mapping', '', 'Generated by `build_mapping.py` from ESP’s data dictionary. Do not edit by hand; change the rules and run it again.', '',
           f'{len(rows)} ESP tables. Every one is in `mapping.csv`; this page lists the business layer, the part DI aligns to.', '', '| Layer | Tables |', '|---|---|']
    out += [f'| {k} | {v} |' for k, v in layers.most_common()]
    out += ['', '## Business layer by status', '', '| Status | Tables | Entities, facts and lookups |', '|---|---|---|']
    for s in (C, P, M, N):
        out.append(f'| {s} | {status[s]} | {sum(1 for r in real if r["status"] == s)} |')
    phases = Counter(str(r['phase']) for r in real if r['phase'] != '')
    names = {'1': 'Accounts, households and customer details', '1b': 'Phase 1 leftovers: product flags, servicing-branch overrides, dividend tiers, a few customer columns', '2': 'Charge-offs, recoveries and insider loans', '3': 'FHLB collateral', '4': 'Account-level monthly snapshots', '5': 'Services and channel activity', '6': 'Account and member profitability', '7': 'Member applications, alerts, deduplication, marketing touches', '8': 'Business relationships and census geography'}
    out += ['', '## Partial and missing tables by phase', '', '| Phase | What | Tables |', '|---|---|---|']
    out += [f'| {p} | {names[p]} | {phases[p]} |' for p in sorted(phases, key=lambda x: (x[0], len(x)))]
    for s in (P, M, C):
        out += ['', f'## {s}', '', '| ESP table | Columns | DI-Next | Phase | Note |', '|---|---|---|---|---|']
        for r in sorted((r for r in real if r['status'] == s), key=lambda r: (str(r['phase']), r['esp_table'])):
            out.append(f"| `{r['esp_table']}` | {r['columns']} | {esc(r['di_tables'])} | {r['phase']} | {esc(r['note'])} |")
    nn = Counter(r['note'] if r['kind'] in ('Entity or fact', 'Lookup') else r['kind'] for r in biz if r['status'] == N)
    out += ['', '## Not needed', '', '| Why | Tables |', '|---|---|'] + [f'| {esc(k)} | {v} |' for k, v in nn.most_common()]
    open(os.path.join(HERE, 'mapping.md'), 'w', encoding='utf-8').write('\n'.join(out) + '\n')

    cols = ['# ESP to DI-Next: hub tables, column by column', '', 'Generated by `build_mapping.py`. **Derived** means DI computes it from the tables named; it isn’t stored.', '']
    by = defaultdict(list)
    for r in col_rows:
        by[r['esp_table']].append(r)
    for name, rs in by.items():
        c = Counter(r['status'] for r in rs)
        cols += [f"## `{name}` → {rs[0]['di_table']}", '', ', '.join(f'{k}: {v}' for k, v in c.most_common()), '', '| ESP column | Status | DI-Next or what it is | Phase |', '|---|---|---|---|']
        cols += [f"| `{r['esp_column']}` | {r['status']} | {esc(r['di_or_note'])} | {r['phase']} |" for r in rs]
        cols.append('')
    open(os.path.join(HERE, 'columns.md'), 'w', encoding='utf-8').write('\n'.join(cols))
    print(f'Wrote mapping.csv ({len(rows)} tables), columns.csv ({len(col_rows)} columns), mapping.md and columns.md.')
    print('Business layer:', dict(status), ' phases:', dict(sorted(phases.items())))


if __name__ == '__main__':
    main(sys.argv[1])
