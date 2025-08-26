// /api/qt/today.json.js  — Vercel Serverless Function (Node 런타임)
import cheerio from 'cheerio';

// (중요) Node 런타임 강제: Edge로 돌면 cheerio가 깨질 수 있음
export const config = { runtime: 'nodejs20.x' };

// 날짜별 Duranno URL 후보들
const buildUrls = (dateStr) => ([
  // 날짜 지정 1
  `https://www.duranno.com/qt/view/bible.asp?qtDate=${dateStr}`,
  // 날짜 지정 2 (혹시 view2가 열릴 때 대비)
  `https://www.duranno.com/qt/view2/bible.asp?qtDate=${dateStr}`,
  // 폴백: 오늘 페이지
  `https://www.duranno.com/qt/view/bible.asp`,
]);

function parseHtml(html) {
  const $ = cheerio.load(html);

  // "오늘의 말씀" 텍스트를 기준으로 섹션을 잡되, 실패 시 전체에서 탐색
  let sectionRoot = null;
  $('*:contains("오늘의 말씀")').each((_, el) => {
    const t = $(el).text().trim();
    if (t.includes('오늘의 말씀') && !sectionRoot) {
      // 가장 가까운 큰 컨테이너
      sectionRoot = $(el).closest('section,article,div');
    }
  });
  if (!sectionRoot || sectionRoot.length === 0) sectionRoot = $('body');

  // 책제목+장절(예: '에스겔 21:1-17')
  const refRegex = /([가-힣A-Za-z.\s]+)\s+(\d+)\s*:\s*(\d+)(?:[-~]\s*\d+)?/;
  let title = null;
  sectionRoot.find('h1,h2,h3,strong,em,p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    const m = t.match(refRegex);
    if (m && !title) title = `${m[1].trim()} ${m[2]}:${m[3]}`;
  });

  // 부제목(짧은 헤드라인)
  let subtitle = null;
  sectionRoot.find('h1,h2,h3,strong,em').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (title && t.includes(title)) return;
    if (t.includes('오늘의 말씀')) return;
    if (t.length <= 60 && !subtitle) subtitle = t;
  });

  // 본문 수집
  let collecting = false;
  const verseParts = [];
  sectionRoot.find('*').each((_, el) => {
    const tag = (el.tagName || '').toLowerCase();
    const t = $(el).text().trim();
    if (t.includes('오늘의 말씀')) { collecting = true; return; }
    if (collecting) {
      if (['h1','h2','h3'].includes(tag) && t.length <= 60) { collecting = false; return; }
      if (['p','li','blockquote'].includes(tag)) {
        const s = t.replace(/\s+/g, ' ').trim();
        if (s && !s.includes('묵상') && !s.includes('요약')) verseParts.push(s);
      }
    }
  });

  // 폴백: 그래도 비었으면 상단 몇 개 p를 모아보기
  if (verseParts.length === 0) {
    sectionRoot.find('p').slice(0, 8).each((_, el) => {
      const s = $(el).text().replace(/\s+/g, ' ').trim();
      if (s) verseParts.push(s);
    });
  }

  return {
    title: title || '본문 참조 미확인',
    subtitle: subtitle || '제목 미확인',
    verse: verseParts.join('\n\n')
  };
}

export default async function handler(req, res) {
  const start = Date.now();
  try {
    // 클라이언트에서 ?qtDate=YYYY-MM-DD를 주면 우선 사용
    const clientDate = String(req.query?.qtDate || '').trim();
    const todayStrUtc = new Date().toISOString().slice(0, 10);
    // 값이 없으면 일단 UTC 오늘 사용 (권장: 프런트에서 KST 날짜를 넣어 호출)
    const qtDate = clientDate || todayStrUtc;

    let html = null, finalUrl = null, lastErr = null, httpStatus = null;

    for (const u of buildUrls(qtDate)) {
      try {
        const r = await fetch(u, {
          // 캐시 안해 (Vercel 내부 캐시와 충돌 방지)
          cache: 'no-store',
          headers: {
            'User-Agent':
