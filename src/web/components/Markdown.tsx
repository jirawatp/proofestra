import React, { useMemo } from "react";
import { parseMarkdown, type BlockNode, type InlineNode } from "../markdown.js";

export function Markdown({ text }: { text: string }): JSX.Element {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="md">
      {blocks.map((block, i) => (
        <Block key={i} node={block} />
      ))}
    </div>
  );
}

function Block({ node }: { node: BlockNode }): JSX.Element {
  switch (node.kind) {
    case "paragraph":
      return <p>{renderInline(node.children)}</p>;
    case "heading":
      switch (node.level) {
        case 1:
          return <h1>{renderInline(node.children)}</h1>;
        case 2:
          return <h2>{renderInline(node.children)}</h2>;
        default:
          return <h3>{renderInline(node.children)}</h3>;
      }
    case "code":
      return (
        <pre>
          <code className={node.language ? `lang-${node.language}` : undefined}>{node.value}</code>
        </pre>
      );
    case "list":
      if (node.ordered) {
        return (
          <ol>
            {node.items.map((item, i) => (
              <li key={i}>{renderInline(item)}</li>
            ))}
          </ol>
        );
      }
      return (
        <ul>
          {node.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "blockquote":
      return <blockquote>{renderInline(node.children)}</blockquote>;
    case "divider":
      return <hr />;
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

function renderInline(children: InlineNode[]): React.ReactNode {
  return children.map((child, i) => <InlineRender key={i} node={child} />);
}

function InlineRender({ node }: { node: InlineNode }): JSX.Element {
  switch (node.kind) {
    case "text":
      return <>{node.value}</>;
    case "code":
      return <code>{node.value}</code>;
    case "bold":
      return <strong>{renderInline(node.children)}</strong>;
    case "italic":
      return <em>{renderInline(node.children)}</em>;
    case "link":
      return (
        <a href={node.href} rel="noreferrer noopener" target="_blank">
          {renderInline(node.children)}
        </a>
      );
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}
