'use strict';

const axios = require('axios');
const {
  CITY_DISPLAY,
  isIndiaLocation,
  findCities,
  detectWorkplace,
  detectJobType,
  detectExperience,
  detectSkills,
  stripHtml,
  htmlToReadableText,
} = require('./classify');

const http = axios.create({
  timeout: 30000,
  headers: { 'User-Agent': 'SkillmedhaJobs/1.0' },
});

// "Hyderabad, , India" → "Hyderabad, India"; "hosur road bangalore" → "Hosur Road Bangalore"
const cleanPlace = (s) =>
  String(s || '')
    .replace(/\s*,\s*(,\s*)+/g, ', ')
    .replace(/^[\s,\-–|]+|[\s,\-–|]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Readable location: known cities by their proper names, others cleaned up.
function displayLocation(locations, cities) {
  if (cities.length) {
    const names = cities.map((c) => CITY_DISPLAY[c] || c);
    return names.length > 3 ? `${names.slice(0, 3).join(' · ')} +${names.length - 3}` : names.join(' · ');
  }
  const cleaned = [...new Set(locations.map(cleanPlace).filter(Boolean))];
  return cleaned.slice(0, 3).join(' · ') || 'India';
}

// One shape for every provider — only India jobs are returned.
function buildJob(company, raw) {
  const locationText = raw.locations.filter(Boolean).join(' | ');
  const cities = company.provider === 'jobicy' ? [] : findCities(locationText);
  // Keep paragraphs and bullets so the details view reads like the real post.
  const description = raw.descriptionHtml
    ? htmlToReadableText(raw.descriptionHtml)
    : String(raw.description || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const exp = detectExperience(raw.title, `${raw.title}. ${description}`, raw.providerLevel);

  return {
    sourceKey: `${company.provider}:${company.slug}:${raw.id}`,
    companyKey: `${company.provider}:${company.slug}`,
    provider: company.provider,
    source: company.source || 'Company careers page',
    company: raw.company || company.name,
    companyLogo: raw.companyLogo || null,
    title: raw.title,
    department: raw.department || null,
    location: company.provider === 'jobicy' ? raw.locations[0] : displayLocation(raw.locations, cities),
    cities,
    workplace: detectWorkplace(raw.workplace, locationText),
    jobType: detectJobType(raw.jobType, raw.title),
    experienceLevel: exp.experienceLevel,
    minExperience: exp.minExperience,
    maxExperience: exp.maxExperience,
    skills: detectSkills(raw.title, description, raw.department),
    salary: raw.salary || null,
    applyLink: raw.applyLink,
    postedAt: raw.postedAt ? new Date(raw.postedAt) : null,
    description: description.slice(0, 6000), // shown in the job details view
  };
}

async function fetchGreenhouse(company) {
  const { data } = await http.get(
    `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs`,
    { params: { content: true } }
  );
  return (data?.jobs || [])
    .filter((j) => isIndiaLocation(j.location?.name))
    .map((j) =>
      buildJob(company, {
        id: j.id,
        title: j.title,
        department: j.departments?.[0]?.name,
        locations: [j.location?.name],
        workplace: null,
        jobType: null,
        descriptionHtml: j.content,
        applyLink: j.absolute_url,
        postedAt: j.first_published || j.updated_at,
      })
    );
}

async function fetchLever(company) {
  const { data } = await http.get(`https://api.lever.co/v0/postings/${company.slug}`, {
    params: { mode: 'json' },
  });
  return (Array.isArray(data) ? data : [])
    .filter((j) => {
      const locs = [j.categories?.location, ...(j.categories?.allLocations || [])].join(' ');
      return j.country === 'IN' || isIndiaLocation(locs);
    })
    .map((j) => {
      const lists = (j.lists || []).map((l) => `<h4>${l.text}</h4><ul>${l.content}</ul>`).join('');
      return buildJob(company, {
        id: j.id,
        title: j.text,
        department: j.categories?.team || j.categories?.department,
        locations: j.categories?.allLocations?.length
          ? j.categories.allLocations
          : [j.categories?.location],
        workplace: j.workplaceType,
        jobType: j.categories?.commitment,
        descriptionHtml: `${j.description || ''}${lists}${j.additional || ''}`,
        applyLink: j.hostedUrl,
        postedAt: j.createdAt,
      });
    });
}

async function fetchSmartRecruiters(company) {
  const jobs = [];
  let offset = 0;
  const limit = 100;
  // country=in → India only; paginate until all are read
  for (let guard = 0; guard < 20; guard++) {
    const { data } = await http.get(
      `https://api.smartrecruiters.com/v1/companies/${company.slug}/postings`,
      { params: { country: 'in', limit, offset } }
    );
    const page = data?.content || [];
    for (const j of page) {
      const loc = j.location || {};
      jobs.push(
        buildJob(company, {
          id: j.id,
          title: j.name,
          department: j.department?.label || j.function?.label,
          locations: [loc.fullLocation || [loc.city, 'India'].filter(Boolean).join(', ')],
          workplace: loc.remote ? 'remote' : loc.hybrid ? 'hybrid' : 'onsite',
          jobType: j.typeOfEmployment?.label,
          providerLevel: j.experienceLevel?.id,
          description: '',
          applyLink: `https://jobs.smartrecruiters.com/${j.company?.identifier || company.slug}/${j.id}`,
          postedAt: j.releasedDate,
        })
      );
    }
    offset += page.length;
    if (!page.length || offset >= (data?.totalFound || 0)) break;
  }
  return jobs;
}

async function fetchAshby(company) {
  const { data } = await http.get(
    `https://api.ashbyhq.com/posting-api/job-board/${company.slug}`
  );
  return (data?.jobs || [])
    .filter((j) => j.isListed !== false)
    .filter((j) => {
      const locs = [j.location, ...(j.secondaryLocations || []).map((s) => s.location)].join(' ');
      return isIndiaLocation(locs) || isIndiaLocation(j.address?.postalAddress?.addressCountry);
    })
    .map((j) =>
      buildJob(company, {
        id: j.id,
        title: j.title,
        department: j.department || j.team,
        locations: [j.location, ...(j.secondaryLocations || []).map((s) => s.location)],
        workplace: j.workplaceType || (j.isRemote ? 'remote' : null),
        jobType: j.employmentType,
        description: j.descriptionPlain,
        applyLink: j.jobUrl,
        postedAt: j.publishedAt,
      })
    );
}

// Jobicy — free public remote-jobs API, no key. slug = region ("anywhere",
// "apac"), both open to people in India. Their notice asks us to credit Jobicy
// and send Apply to the original job URL, which applyLink does.
async function fetchJobicy(company) {
  const { data } = await http.get('https://jobicy.com/api/v2/remote-jobs', {
    params: { count: 100, geo: company.slug },
  });
  // Keep only jobs open to India (worldwide, all of APAC/Asia, or India itself).
  const openToIndia = (geo) => /anywhere|worldwide|apac|asia|india/i.test(String(geo || 'Anywhere'));
  return (data?.jobs || []).filter((j) => j.url && openToIndia(j.jobGeo)).map((j) =>
    buildJob(company, {
      id: j.id,
      title: stripHtml(j.jobTitle),
      company: j.companyName,
      companyLogo: j.companyLogo,
      department: Array.isArray(j.jobIndustry) ? stripHtml(j.jobIndustry[0]) : null,
      locations: [`Remote · ${j.jobGeo || 'Anywhere'}`],
      workplace: 'remote',
      jobType: Array.isArray(j.jobType) ? j.jobType[0] : j.jobType,
      providerLevel: /entry|junior/i.test(j.jobLevel || '') ? 'entry_level' : j.jobLevel,
      descriptionHtml: j.jobDescription || j.jobExcerpt,
      applyLink: j.url,
      postedAt: j.pubDate,
      salary:
        j.annualSalaryMin || j.annualSalaryMax
          ? { min: j.annualSalaryMin || null, max: j.annualSalaryMax || null, currency: j.salaryCurrency || null, period: 'year' }
          : null,
    })
  );
}

const FETCHERS = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  smartrecruiters: fetchSmartRecruiters,
  ashby: fetchAshby,
  jobicy: fetchJobicy,
};

async function fetchCompanyJobs(company) {
  const fetcher = FETCHERS[company.provider];
  if (!fetcher) throw new Error(`Unknown provider ${company.provider}`);
  return (await fetcher(company)).filter((j) => j.title && j.applyLink);
}

module.exports = { fetchCompanyJobs };
