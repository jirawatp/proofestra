// Builds a small valid PDF at test time (text pages, optional Info Title) so
// hostile variants never need to be committed as fixtures.

export function buildPdf(pages: number, opts: { title?: string } = {}): Buffer {
  const objects: string[] = [];
  // 1 catalog, 2 pages, 3 font, 4 info, then (page, content) pairs.
  const pageObjNums: number[] = [];
  const firstPage = 5;
  for (let i = 0; i < pages; i += 1) pageObjNums.push(firstPage + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const title = (opts.title ?? "synthetic").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  objects[4] = `<< /Title (${title.replace(/\n/g, "\\n")}) >>`;
  for (let i = 0; i < pages; i += 1) {
    const pageNum = pageObjNums[i]!;
    const contentNum = pageNum + 1;
    const label = `PAGE_${String(i + 1).padStart(2, "0")}_BUILT`;
    const stream = `BT /F1 12 Tf 72 720 Td (${label}) Tj ET`;
    objects[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[contentNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n += 1) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n += 1) {
    out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
