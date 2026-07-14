"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Upload, FileDown } from "lucide-react";
import { parseLeadsCsv, LEAD_CSV_TEMPLATE, type CsvParseResult } from "@/lib/csv";

/**
 * Inline CSV picker: a drag-and-drop file zone that parses a leads CSV in the
 * browser and hands the result back via `onParsed`. Deliberately has no
 * Dialog of its own so it can be embedded directly inside another dialog
 * (the campaign creator) without nesting modals, as well as inside the Leads
 * import dialog.
 */
export function CsvDropzone({
  onParsed,
  templateFileName = "leads-template.csv",
}: {
  onParsed: (result: CsvParseResult | null) => void;
  templateFileName?: string;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Monotonic id for the in-flight read. Picking a new file bumps it so a
  // slower earlier FileReader that resolves out of order can't overwrite the
  // newer file's parsed rows (or clear its filename on a stale error).
  const readSeq = useRef(0);

  function handleFile(file: File) {
    const seq = (readSeq.current += 1);
    setFileName(file.name);
    onParsed(null); // clear stale rows until this read resolves
    const reader = new FileReader();
    reader.onload = () => {
      if (seq !== readSeq.current) return; // superseded by a newer selection
      onParsed(parseLeadsCsv(String(reader.result ?? "")));
    };
    reader.onerror = () => {
      if (seq !== readSeq.current) return;
      setFileName(null);
      toast.error("Could not read that file");
    };
    reader.readAsText(file);
  }

  function downloadTemplate() {
    const blob = new Blob([LEAD_CSV_TEMPLATE], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = templateFileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-2">
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <label
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed p-6 text-center transition-colors ${
          dragging ? "border-primary bg-accent" : "hover:bg-accent/50"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) handleFile(file);
        }}
      >
        <Upload className="size-5 text-muted-foreground" />
        <div className="text-sm">
          {fileName ? (
            <span className="font-medium">{fileName}</span>
          ) : (
            <>
              <span className="font-medium text-primary">Choose a file</span>
              <span className="text-muted-foreground"> or drag it here</span>
            </>
          )}
        </div>
        <input
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </label>

      <button
        type="button"
        onClick={downloadTemplate}
        className="flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground"
      >
        <FileDown className="size-3.5" /> Download template
      </button>
    </div>
  );
}

export type { CsvParseResult };
