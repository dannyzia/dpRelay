import React, {
  useMemo,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import apiDocsRaw from "../../docs/api-docs.md?raw";

/* ──────────────────────────────────────────────────────────────
   TOC extraction
   ────────────────────────────────────────────────────────────── */

/**
 * Parse markdown headings (## and ### only) into a flat TOC array.
 * Skips the first H1 (the page title) and any H4+.
 */
function extractToc(md) {
  const lines = md.split("\n");
  const items = [];
  let h1Count = 0;

  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+)$/);
    if (!m) continue;

    const level = m[1].length;
    // Skip the first H1 (it's the page title, rendered separately)
    if (level === 1) {
      h1Count++;
      if (h1Count <= 1) continue;
    }

    const raw = m[2]
      .replace(/\*\*/g, "")
      .replace(/`[^`]+`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();

    const id = slugify(raw);

    items.push({ level, title: raw, id });
  }
  return items;
}

/**
 * Convert a plain-text string into a URL-friendly slug.
 * Shared between extractToc and headingId so IDs always match.
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/* ──────────────────────────────────────────────────────────────
   Custom markdown components (Tailwind-styled, light theme)
   ────────────────────────────────────────────────────────────── */

/**
 * Recursively extract plain text from React children (strings, elements,
 * and arrays of both) so that heading IDs match the TOC slugs exactly.
 */
function textFromChildren(children) {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textFromChildren).join("");
  if (children?.props?.children)
    return textFromChildren(children.props.children);
  return "";
}

function headingId(children) {
  return slugify(textFromChildren(children));
}

/* eslint-disable react/prop-types */
const mdComponents = {
  h1: ({ children }) => (
    <h1
      id={headingId(children)}
      className="text-3xl font-bold text-gray-900 mt-0 mb-6 pb-4 border-b border-gray-200"
    >
      {children}
    </h1>
  ),

  h2: ({ children }) => (
    <h2
      id={headingId(children)}
      className="text-2xl font-bold text-gray-900 mt-12 mb-4 pt-2 scroll-mt-20"
    >
      {children}
    </h2>
  ),

  h3: ({ children }) => (
    <h3
      id={headingId(children)}
      className="text-lg font-semibold text-gray-900 mt-8 mb-3 scroll-mt-20"
    >
      {children}
    </h3>
  ),

  h4: ({ children }) => (
    <h4
      id={headingId(children)}
      className="text-base font-semibold text-gray-800 mt-6 mb-2 scroll-mt-20"
    >
      {children}
    </h4>
  ),

  p: ({ children }) => (
    <p className="text-gray-700 leading-relaxed mb-4">{children}</p>
  ),

  ul: ({ children }) => (
    <ul className="list-disc list-outside ml-6 mb-4 space-y-1 text-gray-700">
      {children}
    </ul>
  ),

  ol: ({ children }) => (
    <ol className="list-decimal list-outside ml-6 mb-4 space-y-1 text-gray-700">
      {children}
    </ol>
  ),

  li: ({ children }) => <li className="leading-relaxed">{children}</li>,

  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-brand-500 bg-brand-50 rounded-r-lg px-4 py-3 my-4 text-brand-900 text-sm">
      {children}
    </blockquote>
  ),

  table: ({ children }) => (
    <div className="overflow-x-auto mb-6 rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200">{children}</table>
    </div>
  ),

  thead: ({ children }) => <thead className="bg-gray-50">{children}</thead>,

  tbody: ({ children }) => (
    <tbody className="bg-white divide-y divide-gray-200">{children}</tbody>
  ),

  tr: ({ children }) => <tr>{children}</tr>,

  th: ({ children }) => (
    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider whitespace-nowrap">
      {children}
    </th>
  ),

  td: ({ children }) => (
    <td className="px-4 py-3 text-sm text-gray-700">{children}</td>
  ),

  code: ({ inline, className, children }) => {
    if (inline) {
      return (
        <code className="bg-gray-100 text-brand-700 px-1.5 py-0.5 rounded text-sm font-mono">
          {children}
        </code>
      );
    }
    // Block code — rehype-highlight handles the highlighting.
    return (
      <code className={`${className || ""} text-sm leading-relaxed`}>
        {children}
      </code>
    );
  },

  pre: ({ children }) => (
    <pre className="bg-gray-50 border border-gray-200 rounded-xl p-5 overflow-x-auto my-4 text-sm leading-relaxed [&_code]:!bg-transparent [&_code]:!p-0">
      {children}
    </pre>
  ),

  a: ({ href, children }) => {
    // Internal anchor links (#) should scroll in-page, not open a new tab
    if (href && href.startsWith("#")) {
      return (
        <span
          onClick={(e) => {
            e.preventDefault();
            const el = document.getElementById(href.slice(1));
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          }}
          className="text-brand-600 hover:text-brand-700 underline underline-offset-2 cursor-pointer"
        >
          {children}
        </span>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand-600 hover:text-brand-700 underline underline-offset-2"
      >
        {children}
      </a>
    );
  },

  hr: () => <hr className="my-8 border-gray-200" />,

  strong: ({ children }) => (
    <strong className="font-semibold text-gray-900">{children}</strong>
  ),

  em: ({ children }) => <em className="italic text-gray-600">{children}</em>,
};
/* eslint-enable react/prop-types */

/* ──────────────────────────────────────────────────────────────
   Main component
   ────────────────────────────────────────────────────────────── */

export default function APIDocs() {
  const contentRef = useRef(null);
  const [activeId, setActiveId] = useState("");
  const [mobileTocOpen, setMobileTocOpen] = useState(false);

  const toc = useMemo(() => extractToc(apiDocsRaw), []);

  /* ── Scroll-spy: highlight the currently visible heading in the TOC ── */
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the topmost visible heading
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      {
        rootMargin: "-80px 0px -60% 0px",
        threshold: 0,
      },
    );

    // Observe all h2 and h3 inside the content area
    const headings = container.querySelectorAll("h2[id], h3[id]");
    headings.forEach((h) => observer.observe(h));

    return () => observer.disconnect();
  }, []);

  /* ── Smooth-scroll to heading ── */
  const scrollTo = useCallback((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      // Update URL hash without triggering a navigation
      window.history.replaceState(null, "", `#${id}`);
      setMobileTocOpen(false);
    }
  }, []);

  /* ── TOC sidebar (rendered once, used in both desktop & mobile) ── */
  const tocNav = (
    <nav className="space-y-0.5">
      {toc.map((item) => (
        <button
          key={item.id}
          onClick={() => scrollTo(item.id)}
          className={`block w-full text-left text-sm leading-snug rounded-md transition-colors ${
            item.level === 1
              ? "font-semibold"
              : item.level === 2
                ? "pl-3"
                : "pl-6"
          } ${
            activeId === item.id
              ? "text-brand-700 bg-brand-50 font-medium"
              : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
          }`}
        >
          {item.title}
        </button>
      ))}
    </nav>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {/* ── Page header ── */}
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold text-gray-900">
          API Documentation
        </h1>
        <p className="mt-2 text-lg text-gray-600">
          Complete reference for integrating OTP verification into your
          application.
        </p>
      </div>

      {/* ── Body: TOC sidebar + Content ── */}
      <div className="flex gap-8">
        {/* Desktop TOC sidebar */}
        <aside className="hidden lg:block w-64 shrink-0">
          <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto rounded-lg border border-gray-200 bg-white p-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              On This Page
            </p>
            {tocNav}
          </div>
        </aside>

        {/* Mobile TOC toggle */}
        <div className="lg:hidden fixed bottom-6 right-6 z-50">
          <button
            onClick={() => setMobileTocOpen(!mobileTocOpen)}
            className="w-12 h-12 rounded-full bg-brand-600 text-white shadow-lg flex items-center justify-center hover:bg-brand-700 transition-colors"
            aria-label="Toggle table of contents"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 6h16M4 12h16M4 18h7"
              />
            </svg>
          </button>

          {mobileTocOpen && (
            <div className="absolute bottom-16 right-0 w-72 max-h-80 overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 shadow-xl">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                On This Page
              </p>
              {tocNav}
            </div>
          )}
        </div>

        {/* Main markdown content */}
        <div
          ref={contentRef}
          className="flex-1 min-w-0 rounded-lg border border-gray-200 bg-white p-6 sm:p-8"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={mdComponents}
          >
            {apiDocsRaw}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
