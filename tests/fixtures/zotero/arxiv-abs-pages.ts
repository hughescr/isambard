/**
 * Trimmed arxiv.org/abs/<id> pages for the ArxivResolver abs-page fallback tests.
 *
 * Kept as a TypeScript module rather than .html files: the Stryker sandbox copies only
 * `tests/**\/*.ts` and `tests/**\/*.json`, so an .html fixture is missing there and the
 * mutation dry run fails with ENOENT.
 */

/** arxiv.org/abs/1706.03762: a new-style id and no DOI. */
export const ABS_ATTENTION = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>[1706.03762] Attention Is All You Need</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="citation_title" content="Attention Is All You Need"/>
  <meta name="citation_author" content="Vaswani, Ashish"/>
  <meta name="citation_author" content="Shazeer, Noam"/>
  <meta name="citation_author" content="Parmar, Niki"/>
  <meta name="citation_author" content="Gomez, Aidan N."/>
  <meta name="citation_date" content="2017/06/12"/>
  <meta name="citation_online_date" content="2023/08/02"/>
  <meta name="citation_pdf_url" content="https://arxiv.org/pdf/1706.03762v7"/>
  <meta name="citation_arxiv_id" content="1706.03762"/>
  <meta name="citation_abstract" content="The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks &amp; more."/>
</head>
<body>
<h1>Attention Is All You Need</h1>
</body>
</html>
`;

/** arxiv.org/abs/hep-th/9711200: an old-style slash id with a journal DOI. */
export const ABS_MALDACENA = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>[hep-th/9711200] The Large N Limit of Superconformal Field Theories and Supergravity</title>
  <meta name="citation_title" content="The Large N Limit of Superconformal Field Theories and Supergravity"/>
  <meta name="citation_author" content="Maldacena, Juan"/>
  <meta name="citation_date" content="1997/11/27"/>
  <meta name="citation_online_date" content="1999/01/22"/>
  <meta name="citation_pdf_url" content="https://arxiv.org/pdf/hep-th/9711200v3"/>
  <meta name="citation_arxiv_id" content="hep-th/9711200v3"/>
  <meta name="citation_doi" content="10.1023/A:1026654312961"/>
  <meta name="citation_abstract" content="We show that the large N limit of certain conformal field theories in various dimensions."/>
</head>
<body>
<h1>The Large N Limit</h1>
</body>
</html>
`;
