import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

export type GraphState = { runId: string; done: boolean };

const State = Annotation.Root({
  runId: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  done: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
});

export function compileRunGraph(
  checkpointPath: string,
  node: (state: GraphState) => Promise<GraphState>,
) {
  const saver = SqliteSaver.fromConnString(checkpointPath);
  const graph = new StateGraph(State)
    .addNode("execute", node)
    .addEdge(START, "execute")
    .addEdge("execute", END)
    .compile({ checkpointer: saver });
  return { graph, saver };
}
