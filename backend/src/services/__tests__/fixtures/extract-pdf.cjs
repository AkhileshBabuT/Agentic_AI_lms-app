// Run in a separate Node process so a delayed PDF.js rejection reproduces worker termination.
const fs = require('node:fs');
const { extractTextFromFile } = require('../../documentProcessor');
extractTextFromFile(fs.readFileSync(process.argv[2]), 'embedded-font.pdf', 'application/pdf')
  .then(result => console.log(JSON.stringify({ text: result.content_text, pages: result.metadata.page_count,
    degraded: !!result.metadata.extraction_degraded, pageNumbers: result.content_chunks.map(c => c.metadata.page_number) })))
  .catch(() => { process.exitCode = 1; });
