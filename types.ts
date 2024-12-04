export type Node = {
  identifier: string;
  label: string;
  label_level: string;
  label_description: string;
  reserved: boolean;
  type: string;
  children: Node[];
};

export type ParsedNode = {
  original: Omit<Node, "children"> | Record<string, unknown>;
  jurisdiction: string;
  regulators: { code: string; title: string }[];
  metadata: Record<string, unknown>;
  code: string;
  citation: string;
  parents: {
    code: string;
    title: string;
    type: string;
  }[];
  type: string;
  title: string;
  markdown: string;
  text: string;
};

export type ParsedNodeWithChildren = ParsedNode & {
  children: ParsedNodeWithChildren[];
};
