// Demo network: fixed IDs, API keys and easy username/password logins, created by `npm run seed`
// (or applied to an existing database by `npm run demo-logins`). Shown on the sign-in page
// only when DEMO_MODE=true. The admin account is never listed; its password is ADMIN_PASSWORD.
export const DEMO_ACCOUNTS = [
  { key: 'gt_demo_regulator', id: 'ACT-REGL01', name: 'Regional Drug & Device Regulator', role: 'regulator', org: 'Demo Regulatory Authority', username: 'regulator', password: 'Regulator@123' },
  { key: 'gt_demo_pharma', id: 'ACT-PHRM01', name: 'Sanjeevani Pharma Ltd', role: 'manufacturer', org: 'Pharma', username: 'pharma', password: 'Pharma@123' },
  { key: 'gt_demo_distributor', id: 'ACT-DIST01', name: 'MedLink Distributors', role: 'distributor', org: 'Pharma logistics', username: 'distributor', password: 'Distributor@123' },
  { key: 'gt_demo_pharmacy', id: 'ACT-PHAR01', name: 'CarePlus Pharmacy', role: 'pharmacy', org: 'Retail pharmacy', username: 'pharmacy', password: 'Pharmacy@123' },
  { key: 'gt_demo_hospital', id: 'ACT-HOSP01', name: 'City General Hospital', role: 'hospital', org: 'Hospital procurement', username: 'hospital', password: 'Hospital@123' },
  { key: 'gt_demo_phonemaker', id: 'ACT-NOVA01', name: 'Nova Mobile', role: 'manufacturer', org: 'Electronics', username: 'nova', password: 'Nova@123' },
  { key: 'gt_demo_panelmaker', id: 'ACT-LUMI01', name: 'Lumina Display Co.', role: 'manufacturer', org: 'Display panels', username: 'lumina', password: 'Lumina@123' },
  { key: 'gt_demo_retailer', id: 'ACT-RETL01', name: 'Digital Hub Stores', role: 'retailer', org: 'Electronics retail', username: 'retailer', password: 'Retailer@123' },
  { key: 'gt_demo_service', id: 'ACT-SERV01', name: 'Nova Care Service Centre', role: 'service_center', org: 'Authorised service', username: 'service', password: 'Service@123' },
  { key: 'gt_demo_logistics', id: 'ACT-LOGI01', name: 'SwiftRoute Logistics', role: 'logistics', org: 'Carrier', username: 'logistics', password: 'Logistics@123' },
];
