import argparse
import json
import os
import re
import sys

from pageindex import PageIndexClient


def load_payload(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def words(text):
    return set(re.findall(r"[\w]+", (text or "").lower()))


def walk_nodes(nodes):
    for node in nodes or []:
        yield node
        for child in walk_nodes(node.get("nodes") or []):
            yield child


def node_page(node):
    value = node.get("start_index") or node.get("page") or node.get("line_num")
    try:
        return int(value)
    except Exception:
        return None


def index(payload):
    client = PageIndexClient(
        workspace=payload["workspace"],
        model=payload.get("model"),
        retrieve_model=payload.get("retrieve_model"),
    )
    doc_id = client.index(payload["file_path"], mode=payload.get("mode") or "auto")
    return {"doc_id": doc_id, "document": json.loads(client.get_document(doc_id))}


def search(payload):
    client = PageIndexClient(workspace=payload["workspace"], retrieve_model=payload.get("retrieve_model"))
    query_terms = words(payload.get("query") or "")
    limit = int(payload.get("limit") or 10)
    results = []

    for doc_id in payload.get("doc_ids") or []:
        try:
            structure = json.loads(client.get_document_structure(doc_id))
        except Exception:
            continue

        for node in walk_nodes(structure):
            haystack = " ".join(
                str(node.get(key) or "") for key in ["title", "summary", "doc_description", "text"]
            )
            node_terms = words(haystack)
            score = len(query_terms & node_terms)
            if query_terms and score <= 0:
                continue
            page = node_page(node)
            snippet = node.get("summary") or node.get("text") or node.get("title") or ""
            if page:
                try:
                    pages = json.loads(client.get_page_content(doc_id, str(page)))
                    if pages and pages[0].get("content"):
                        snippet = pages[0]["content"][:1200]
                except Exception:
                    pass

            results.append(
                {
                    "doc_id": doc_id,
                    "title": node.get("title") or "",
                    "snippet": snippet,
                    "page": page,
                    "node_id": node.get("node_id") or "",
                    "score": score,
                }
            )

    results.sort(key=lambda item: item.get("score") or 0, reverse=True)
    return {"results": results[:limit]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["index", "search"])
    parser.add_argument("--payload", required=True)
    args = parser.parse_args()
    payload = load_payload(args.payload)
    if args.action == "index":
        result = index(payload)
    else:
        result = search(payload)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        sys.stderr.write(str(exc))
        sys.exit(1)

