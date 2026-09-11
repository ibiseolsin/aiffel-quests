"""환경 확인용 최소 그래프 — LLM 호출 없이 State·Node·Edge 만 돈다."""
from typing import TypedDict

from langgraph.graph import END, START, StateGraph


class State(TypedDict):
    text: str


def upper(state: State) -> State:
    return {"text": state["text"].upper()}


def exclaim(state: State) -> State:
    return {"text": state["text"] + "!"}


builder = StateGraph(State)
builder.add_node("upper", upper)
builder.add_node("exclaim", exclaim)
builder.add_edge(START, "upper")
builder.add_edge("upper", "exclaim")
builder.add_edge("exclaim", END)
graph = builder.compile()

if __name__ == "__main__":
    from importlib.metadata import version

    import langchain_openai  # noqa: F401

    print("langgraph", version("langgraph"), "/ langchain-openai", version("langchain-openai"))
    print(graph.invoke({"text": "hello langgraph"}))
