// "Member" at credit unions, "customer" at banks (spec 10.11, FE-DS-050). Strings that name a
// person use these terms; full ICU message catalogues arrive with i18n.
import type { InstitutionType } from '@dinext/block-schemas';

export interface Terms {
  person: string;
  persons: string;
  Person: string;
  Persons: string;
  /** Route segment for the 360 view (spec 11.4). */
  personRoute: 'members' | 'customers';
}

export function terminology(type: InstitutionType): Terms {
  return type === 'bank'
    ? { person: 'customer', persons: 'customers', Person: 'Customer', Persons: 'Customers', personRoute: 'customers' }
    : { person: 'member', persons: 'members', Person: 'Member', Persons: 'Members', personRoute: 'members' };
}
