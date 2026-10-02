'use strict';

// Reads location, experience and job type out of real job text.
// Nothing here invents data: a field we cannot find stays null.

// ─── Cities ──────────────────────────────────────────────────────────────────
// canonical name → spellings seen on job boards
const CITY_ALIASES = {
  bengaluru: ['bengaluru', 'bangalore', 'banglore'],
  hyderabad: ['hyderabad', 'secunderabad'],
  mumbai: ['mumbai', 'bombay', 'navi mumbai', 'thane'],
  pune: ['pune'],
  chennai: ['chennai', 'madras'],
  delhi: ['delhi', 'new delhi'],
  gurugram: ['gurugram', 'gurgaon'],
  noida: ['noida', 'greater noida'],
  kolkata: ['kolkata', 'calcutta'],
  ahmedabad: ['ahmedabad'],
  kochi: ['kochi', 'cochin'],
  coimbatore: ['coimbatore'],
  jaipur: ['jaipur'],
  chandigarh: ['chandigarh', 'mohali'],
  indore: ['indore'],
  thiruvananthapuram: ['thiruvananthapuram', 'trivandrum'],
  mysuru: ['mysuru', 'mysore'],
  vadodara: ['vadodara', 'baroda'],
  nagpur: ['nagpur'],
  bhubaneswar: ['bhubaneswar'],
  visakhapatnam: ['visakhapatnam', 'vizag'],
  vijayawada: ['vijayawada'],
  lucknow: ['lucknow'],
};

const CITY_DISPLAY = {
  bengaluru: 'Bengaluru', hyderabad: 'Hyderabad', mumbai: 'Mumbai', pune: 'Pune',
  chennai: 'Chennai', delhi: 'Delhi', gurugram: 'Gurugram', noida: 'Noida',
  kolkata: 'Kolkata', ahmedabad: 'Ahmedabad', kochi: 'Kochi', coimbatore: 'Coimbatore',
  jaipur: 'Jaipur', chandigarh: 'Chandigarh', indore: 'Indore',
  thiruvananthapuram: 'Thiruvananthapuram', mysuru: 'Mysuru', vadodara: 'Vadodara',
  nagpur: 'Nagpur', bhubaneswar: 'Bhubaneswar', visakhapatnam: 'Visakhapatnam',
  vijayawada: 'Vijayawada', lucknow: 'Lucknow',
};

const INDIA_RE = new RegExp(
  `\\bindia\\b|${Object.values(CITY_ALIASES).flat().join('|')}`,
  'i'
);

function isIndiaLocation(text) {
  return INDIA_RE.test(String(text || ''));
}

function findCities(text) {
  const t = String(text || '').toLowerCase();
  return Object.keys(CITY_ALIASES).filter((city) =>
    CITY_ALIASES[city].some((alias) => t.includes(alias))
  );
}

// What the student typed → canonical city (or null when it isn't a known city)
function normalizeCity(input) {
  const t = String(input || '').trim().toLowerCase();
  if (!t) return null;
  return Object.keys(CITY_ALIASES).find((city) => CITY_ALIASES[city].includes(t)) || null;
}

// ─── Work mode ───────────────────────────────────────────────────────────────
function detectWorkplace(providerValue, locationText) {
  const v = String(providerValue || '').toLowerCase().replace(/[\s_-]/g, '');
  if (v === 'remote') return 'remote';
  if (v === 'hybrid') return 'hybrid';
  if (v === 'onsite' || v === 'inoffice') return 'onsite';
  const loc = String(locationText || '').toLowerCase();
  if (/\bremote\b|work from home|\bwfh\b/.test(loc)) return 'remote';
  if (/\bhybrid\b/.test(loc)) return 'hybrid';
  return 'onsite';
}

// ─── Job type ────────────────────────────────────────────────────────────────
function detectJobType(providerValue, title) {
  const v = String(providerValue || '').toLowerCase();
  const t = String(title || '').toLowerCase();
  if (/intern/.test(v) || /\bintern(ship)?\b/.test(t)) return 'Internship';
  if (/contract|temporary|temp\b|fixed[- ]term/.test(v) || /\bcontract(ual)?\b/.test(t)) return 'Contract';
  if (/part/.test(v)) return 'Part-time';
  if (/full|permanent|regular/.test(v)) return 'Full-time';
  return null;
}

// ─── Experience ──────────────────────────────────────────────────────────────
const FRESHER_TITLE_RE =
  /\b(intern|internship|trainee|graduate|fresher|freshers|entry[- ]level|campus|apprentice|new grad|early career)\b/i;
const SENIOR_TITLE_RE =
  /\b(senior|sr\.?|lead|principal|staff|manager|director|head|architect|vp|vice president|chief)\b/i;

const EXP_CONTEXT = '(?=[^.\\n]{0,60}\\b(experience|exp\\b|work|industry|professional|relevant|hands[- ]on))';
const RANGE_RE = new RegExp(`(\\d{1,2})\\s*\\+?\\s*(?:-|–|to)\\s*(\\d{1,2})\\s*\\+?\\s*(?:years|yrs|year)${EXP_CONTEXT}`, 'gi');
const PLUS_RE = new RegExp(`(\\d{1,2})\\s*\\+?\\s*(?:years|yrs|year)(?:'|’)?${EXP_CONTEXT}`, 'gi');
const MIN_RE = /(?:minimum|min\.?|at least|atleast)\s*(?:of\s*)?(\d{1,2})\s*\+?\s*(?:years|yrs|year)/gi;
// "Experience : 5-7 yrs", "Exp- 8- 10 Years", "Experience: 3+ years"
const LABEL_RE = /\b(?:experience|exp)\b\s*(?:required)?\s*[:\-–]?\s*(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*\+?\s*)?(?:years|yrs|year)/gi;

function extractYears(text) {
  const t = String(text || '').slice(0, 6000);
  const mins = [];
  let max = null;
  let m;

  RANGE_RE.lastIndex = 0;
  while ((m = RANGE_RE.exec(t))) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (lo <= 30 && hi <= 40 && hi >= lo) {
      mins.push(lo);
      max = max === null ? hi : Math.max(max, hi);
    }
  }
  LABEL_RE.lastIndex = 0;
  while ((m = LABEL_RE.exec(t))) {
    const lo = Number(m[1]);
    const hi = m[2] !== undefined ? Number(m[2]) : null;
    if (lo <= 30) {
      mins.push(lo);
      if (hi !== null && hi >= lo && hi <= 40) max = max === null ? hi : Math.max(max, hi);
    }
  }
  for (const re of [PLUS_RE, MIN_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(t))) {
      const n = Number(m[1]);
      if (n <= 30) mins.push(n);
    }
  }
  if (!mins.length) return { min: null, max: null };
  const min = Math.min(...mins);
  return { min, max: max !== null && max >= min ? max : null };
}

// providerLevel: e.g. SmartRecruiters "entry_level", Himalayas "Entry-level"
function detectExperience(title, text, providerLevel) {
  const { min, max } = extractYears(text);
  const level = String(providerLevel || '').toLowerCase();

  let experienceLevel = null;
  if (FRESHER_TITLE_RE.test(title) || min === 0 || /intern|entry/.test(level)) {
    experienceLevel = 'fresher';
  } else if (
    (min !== null && min >= 1) ||
    SENIOR_TITLE_RE.test(title) ||
    /mid|senior|director|executive|lead|manager/.test(level)
  ) {
    experienceLevel = 'experienced';
  }

  return { experienceLevel, minExperience: min, maxExperience: max };
}

// ─── Skills ──────────────────────────────────────────────────────────────────
// Skill name → how it is written in job posts. Only skills actually named in a
// job's title or description are attached to that job.
const SKILLS = {
  // languages
  JavaScript: /\bjavascript\b|\bjs\b/i,
  TypeScript: /\btypescript\b/i,
  Java: /\bjava\b(?!\s*script)/i,
  Python: /\bpython\b/i,
  'C++': /\bc\+\+/i,
  'C#': /\bc#|\.net\b|\bdotnet\b/i,
  Go: /\bgolang\b|\bgo\s+(developer|engineer|programming|language)\b/i,
  Rust: /\brust\b/i,
  Kotlin: /\bkotlin\b/i,
  Swift: /\bswift\b/i,
  PHP: /\bphp\b/i,
  Ruby: /\bruby\b|\brails\b/i,
  Scala: /\bscala\b/i,
  SQL: /\bsql\b/i,
  // web & mobile
  React: /\breact(\.?js)?\b(?!\s*native)/i,
  'React Native': /\breact\s*native\b/i,
  Angular: /\bangular\b/i,
  'Vue.js': /\bvue(\.?js)?\b/i,
  'Next.js': /\bnext\.?js\b/i,
  'Node.js': /\bnode(\.?js)?\b/i,
  Express: /\bexpress(\.?js)?\b/i,
  Django: /\bdjango\b/i,
  Flask: /\bflask\b/i,
  FastAPI: /\bfastapi\b/i,
  Spring: /\bspring(\s*boot)?\b/i,
  HTML: /\bhtml5?\b/i,
  CSS: /\bcss3?\b|\btailwind\b|\bsass\b/i,
  Android: /\bandroid\b/i,
  iOS: /\bios\b/i,
  Flutter: /\bflutter\b/i,
  GraphQL: /\bgraphql\b/i,
  'REST APIs': /\brest(ful)?\s*api/i,
  Microservices: /\bmicro-?services?\b/i,
  // data & AI
  'Machine Learning': /\bmachine\s*learning\b|\bml\b/i,
  'Deep Learning': /\bdeep\s*learning\b/i,
  'Generative AI': /\bgen(erative)?\s*ai\b|\bllms?\b|\blarge language model/i,
  NLP: /\bnlp\b|\bnatural language processing\b/i,
  'Computer Vision': /\bcomputer vision\b/i,
  TensorFlow: /\btensorflow\b/i,
  PyTorch: /\bpytorch\b/i,
  Pandas: /\bpandas\b/i,
  Spark: /\b(apache\s*)?spark\b|\bpyspark\b/i,
  Hadoop: /\bhadoop\b/i,
  Kafka: /\bkafka\b/i,
  Airflow: /\bairflow\b/i,
  'Data Analysis': /\bdata analy(sis|tics)\b/i,
  'Power BI': /\bpower\s*bi\b/i,
  Tableau: /\btableau\b/i,
  Excel: /\b(ms\s*|microsoft\s*)?excel\b/i,
  Statistics: /\bstatistic(s|al)\b/i,
  Snowflake: /\bsnowflake\b/i,
  Databricks: /\bdatabricks\b/i,
  // databases
  MySQL: /\bmysql\b/i,
  PostgreSQL: /\bpostgres(ql)?\b/i,
  MongoDB: /\bmongo(db)?\b/i,
  Redis: /\bredis\b/i,
  Elasticsearch: /\belastic\s*search\b/i,
  Oracle: /\boracle\b/i,
  // cloud & devops
  AWS: /\baws\b|\bamazon web services\b/i,
  Azure: /\bazure\b/i,
  GCP: /\bgcp\b|\bgoogle cloud\b/i,
  Docker: /\bdocker\b/i,
  Kubernetes: /\bkubernetes\b|\bk8s\b/i,
  Terraform: /\bterraform\b/i,
  'CI/CD': /\bci\s*\/\s*cd\b|\bjenkins\b|\bgithub actions\b/i,
  Linux: /\blinux\b|\bunix\b/i,
  Git: /\bgit\b|\bgithub\b|\bgitlab\b/i,
  Networking: /\bnetworking\b|\btcp\/ip\b/i,
  'Cyber Security': /\bcyber\s*security\b|\binformation security\b|\binfosec\b/i,
  // testing
  'Manual Testing': /\bmanual testing\b/i,
  'Automation Testing': /\btest automation\b|\bautomation testing\b/i,
  Selenium: /\bselenium\b/i,
  // enterprise
  Salesforce: /\bsalesforce\b/i,
  SAP: /\bsap\b/i,
  ServiceNow: /\bservicenow\b/i,
  // design & product
  Figma: /\bfigma\b/i,
  'UI/UX': /\bui\s*\/\s*ux\b|\bux design\b|\buser experience\b/i,
  'Product Management': /\bproduct management\b|\bproduct manager\b/i,
  Agile: /\bagile\b|\bscrum\b/i,
  // business
  Sales: /\bsales\b/i,
  Marketing: /\bmarketing\b/i,
  SEO: /\bseo\b/i,
  'Content Writing': /\bcontent writ(ing|er)\b|\bcopywrit/i,
  Accounting: /\baccounting\b|\baccountant\b/i,
  Finance: /\bfinance\b|\bfinancial analy/i,
  Tally: /\btally\b/i,
  Recruitment: /\brecruit(ment|ing|er)\b|\btalent acquisition\b/i,
  'Customer Support': /\bcustomer (support|service|success)\b/i,
  Communication: /\bcommunication skills\b/i,
};

// Words like "sales" or "finance" appear in most company blurbs, so these are
// read from the job's title and team only — not from the description.
const TITLE_ONLY_SKILLS = new Set([
  'Sales', 'Marketing', 'Finance', 'Accounting', 'Recruitment', 'Customer Support',
  'Communication', 'Product Management', 'Agile', 'Data Analysis', 'Statistics', 'Excel',
  'Networking',
]);

function detectSkills(title, description, department) {
  const head = `${title || ''} ${department || ''}`;
  const all = `${head} ${String(description || '').slice(0, 8000)}`;
  return Object.keys(SKILLS).filter((name) =>
    SKILLS[name].test(TITLE_ONLY_SKILLS.has(name) ? head : all)
  );
}

const SKILL_NAMES = Object.keys(SKILLS);

// Only normal web links (https:// or http://) — never javascript: or data: URLs
// coming from an outside feed.
const safeUrl = (u) => {
  const s = String(u || '').trim();
  return /^https?:\/\/\S+$/i.test(s) ? s.slice(0, 2000) : null;
};

const decodeEntities = (s) =>
  String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// One line of plain text (titles, matching).
const stripHtml = (s) =>
  decodeEntities(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Plain text that keeps the post's paragraphs and bullet points, for reading.
const htmlToReadableText = (s) =>
  decodeEntities(s)
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

module.exports = {
  CITY_DISPLAY,
  isIndiaLocation,
  findCities,
  normalizeCity,
  detectWorkplace,
  detectJobType,
  detectExperience,
  detectSkills,
  SKILL_NAMES,
  stripHtml,
  htmlToReadableText,
  safeUrl,
};
