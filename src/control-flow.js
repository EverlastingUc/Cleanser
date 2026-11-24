import ts from "typescript";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildControlFlowGraph(functionNode, sourceFile) {
  if (!ts.isFunctionLike(functionNode) || !functionNode.body) return undefined;
  const nodes = [];
  const edges = [];
  const knownNodes = new Set();
  const knownEdges = new Set();
  const entryId = "entry";
  const exitId = "exit";

  function addNode(node, kind, label) {
    const start = node?.getStart(sourceFile) ?? 0;
    const end = node?.getEnd() ?? start;
    const id = `b${start}`;
    if (!knownNodes.has(id)) {
      knownNodes.add(id);
      nodes.push({ id, kind, label, start, end });
    }
    return id;
  }

  function addEdge(from, to, kind = "next") {
    if (!from || !to) return;
    const key = `${from}\0${to}\0${kind}`;
    if (knownEdges.has(key)) return;
    knownEdges.add(key);
    edges.push({ from, to, kind });
  }

  nodes.push(
    { id: entryId, kind: "entry", label: "entry", start: 0, end: 0 },
    {
      id: exitId,
      kind: "exit",
      label: "exit",
      start: sourceFile.text.length,
      end: sourceFile.text.length,
    },
  );
  knownNodes.add(entryId);
  knownNodes.add(exitId);

  function buildSequence(statements, next, context) {
    let first = next;
    for (let index = statements.length - 1; index >= 0; index--) {
      first = buildStatement(statements[index], first, context);
    }
    return first;
  }

  function buildStatement(statement, next, context) {
    if (ts.isBlock(statement)) {
      return buildSequence(statement.statements, next, context);
    }

    if (ts.isIfStatement(statement)) {
      const condition = addNode(
        statement,
        "condition",
        statement.expression.getText(sourceFile),
      );
      const consequent = buildStatement(statement.thenStatement, next, context);
      const alternate = statement.elseStatement
        ? buildStatement(statement.elseStatement, next, context)
        : next;
      addEdge(condition, consequent, "true");
      addEdge(condition, alternate, "false");
      return condition;
    }

    if (
      ts.isWhileStatement(statement) ||
      ts.isForStatement(statement) ||
      ts.isForInStatement(statement) ||
      ts.isForOfStatement(statement)
    ) {
      const expression = ts.isWhileStatement(statement)
        ? statement.expression.getText(sourceFile)
        : ts.isForStatement(statement)
          ? [
              statement.initializer?.getText(sourceFile),
              statement.condition?.getText(sourceFile) ?? "true",
              statement.incrementor?.getText(sourceFile),
            ]
              .filter(Boolean)
              .join("; ")
          : `${statement.initializer.getText(sourceFile)} of ${statement.expression.getText(sourceFile)}`;
      const condition = addNode(statement, "condition", expression);
      const loopContext = {
        ...context,
        breakTarget: next,
        continueTarget: condition,
      };
      const body = buildStatement(statement.statement, condition, loopContext);
      addEdge(condition, body, "true");
      if (!ts.isForStatement(statement) || statement.condition !== undefined) {
        addEdge(condition, next, "false");
      }
      return condition;
    }

    if (ts.isDoStatement(statement)) {
      const condition = addNode(
        statement,
        "condition",
        statement.expression.getText(sourceFile),
      );
      const loopContext = {
        ...context,
        breakTarget: next,
        continueTarget: condition,
      };
      const body = buildStatement(statement.statement, condition, loopContext);
      addEdge(condition, body, "true");
      addEdge(condition, next, "false");
      return body;
    }

    if (ts.isSwitchStatement(statement)) {
      const condition = addNode(
        statement,
        "condition",
        statement.expression.getText(sourceFile),
      );
      const switchContext = { ...context, breakTarget: next };
      const clauseEntries = [];
      let fallthrough = next;
      for (
        let index = statement.caseBlock.clauses.length - 1;
        index >= 0;
        index--
      ) {
        const clause = statement.caseBlock.clauses[index];
        const clauseBody = buildSequence(
          clause.statements,
          fallthrough,
          switchContext,
        );
        const label = ts.isDefaultClause(clause)
          ? "default"
          : `case ${clause.expression.getText(sourceFile)}`;
        const clauseNode = addNode(clause, "case", label);
        addEdge(clauseNode, clauseBody);
        clauseEntries[index] = { clause, node: clauseNode };
        fallthrough = clauseNode;
      }
      let hasDefault = false;
      for (const { clause, node } of clauseEntries) {
        addEdge(
          condition,
          node,
          ts.isDefaultClause(clause)
            ? "default"
            : `case ${clause.expression.getText(sourceFile)}`,
        );
        if (ts.isDefaultClause(clause)) hasDefault = true;
      }
      if (!hasDefault) addEdge(condition, next, "no-match");
      return condition;
    }

    if (ts.isTryStatement(statement)) {
      const finallyEntry = statement.finallyBlock
        ? buildStatement(statement.finallyBlock, next, {
            ...context,
            finallyTarget: context.finallyTarget,
          })
        : next;
      const catchEntry = statement.catchClause
        ? buildStatement(statement.catchClause.block, finallyEntry, {
            ...context,
            finallyTarget: context.finallyTarget,
          })
        : finallyEntry;
      const protectedContext = {
        ...context,
        finallyTarget: statement.finallyBlock
          ? finallyEntry
          : context.finallyTarget,
        exceptionTarget: statement.catchClause
          ? catchEntry
          : context.exceptionTarget,
      };
      const tryEntry = buildStatement(
        statement.tryBlock,
        finallyEntry,
        protectedContext,
      );
      if (!statement.catchClause && !statement.finallyBlock) return tryEntry;
      const branch = addNode(statement, "branch", "try");
      addEdge(branch, tryEntry, "normal");
      if (statement.catchClause) addEdge(branch, catchEntry, "exception");
      else addEdge(branch, finallyEntry, "exception");
      return branch;
    }

    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      const kind = ts.isReturnStatement(statement) ? "return" : "throw";
      const label = statement.getText(sourceFile).replace(/\s+/gu, " ").trim();
      const terminal = addNode(statement, kind, label);
      const target = ts.isThrowStatement(statement)
        ? (context.exceptionTarget ?? context.finallyTarget ?? exitId)
        : (context.finallyTarget ?? exitId);
      addEdge(terminal, target, kind);
      return terminal;
    }

    if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) {
      const isContinue = ts.isContinueStatement(statement);
      const labelTarget = statement.label
        ? context.labels?.get(statement.label.text)
        : undefined;
      const target = statement.label
        ? labelTarget?.[isContinue ? "continueTarget" : "breakTarget"]
        : isContinue
          ? context.continueTarget
          : context.breakTarget;
      const terminal = addNode(
        statement,
        isContinue ? "continue" : "break",
        statement.getText(sourceFile),
      );
      addEdge(terminal, target ?? exitId, isContinue ? "continue" : "break");
      return terminal;
    }

    if (ts.isLabeledStatement(statement)) {
      const labels = new Map(context.labels ?? []);
      const nested = statement.statement;
      const isLoop =
        ts.isWhileStatement(nested) ||
        ts.isDoStatement(nested) ||
        ts.isForStatement(nested) ||
        ts.isForInStatement(nested) ||
        ts.isForOfStatement(nested);
      labels.set(statement.label.text, {
        breakTarget: next,
        continueTarget: isLoop ? `b${nested.getStart(sourceFile)}` : undefined,
      });
      return buildStatement(statement.statement, next, { ...context, labels });
    }

    const label = statement
      .getText(sourceFile)
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 120);
    const id = addNode(statement, "statement", label);
    addEdge(id, next);
    return id;
  }

  const functionContext = {
    breakTarget: exitId,
    continueTarget: exitId,
    exceptionTarget: exitId,
    finallyTarget: undefined,
    labels: new Map(),
  };
  const body = functionNode.body;
  const first = ts.isBlock(body)
    ? buildSequence(body.statements, exitId, functionContext)
    : addNode(body, "return", body.getText(sourceFile));
  if (!ts.isBlock(body)) addEdge(first, exitId, "return");
  addEdge(entryId, first);

  const controlNodes = nodes
    .filter((node) => node.id !== entryId && node.id !== exitId)
    .sort(
      (left, right) =>
        left.start - right.start ||
        compareText(left.kind, right.kind) ||
        compareText(left.id, right.id),
    );
  nodes.splice(
    0,
    nodes.length,
    { id: entryId, kind: "entry", label: "entry", start: 0, end: 0 },
    ...controlNodes,
    {
      id: exitId,
      kind: "exit",
      label: "exit",
      start: sourceFile.text.length,
      end: sourceFile.text.length,
    },
  );
  edges.sort(
    (left, right) =>
      compareText(left.from, right.from) ||
      compareText(left.kind, right.kind) ||
      compareText(left.to, right.to),
  );
  return { nodes, edges };
}
