"use strict";
(() => {
  const worksheet = document.querySelector("[data-public-worksheet]");
  if (!worksheet) return;
  const fields = [...worksheet.querySelectorAll("textarea")];
  const preview = worksheet.querySelector("[data-preview]");
  const status = worksheet.querySelector("[role=status]");
  const download = worksheet.querySelector("[data-download]");
  const clear = worksheet.querySelector("[data-clear]");
  const example = worksheet.querySelector("[data-example-button]");
  const heading = document.querySelector("h1").textContent;
  function text() {
    return heading + "\n\n" + fields.map(field => {
      const label = worksheet.querySelector(`label[for="${field.id}"]`).textContent;
      return label + "\n" + (field.value || "[No note yet]");
    }).join("\n\n");
  }
  function refresh() {
    preview.textContent = text();
    const empty = fields.every(field => !field.value.trim());
    download.disabled = empty;
    clear.disabled = empty;
    example.disabled = !empty;
  }
  function reset() {
    fields.forEach(field => { field.value = ""; });
    refresh();
  }
  fields.forEach(field => field.addEventListener("input", () => {
    status.textContent = "";
    refresh();
  }));
  example.addEventListener("click", () => {
    fields.forEach(field => { field.value = field.dataset.example; });
    refresh();
    status.textContent = "Example loaded. Replace the sample notes with your own words.";
  });
  clear.addEventListener("click", () => {
    reset();
    status.textContent = "Worksheet cleared.";
    fields[0].focus();
  });
  download.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([text() + "\n"], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = worksheet.dataset.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = "Download requested. Clear your notes when you are finished.";
  });
  reset();
  worksheet.querySelector("[data-controls]").hidden = false;
  window.addEventListener("pageshow", event => { if (event.persisted) reset(); });
  window.addEventListener("pagehide", reset);
})();
