# plugin-build-guide-block

## Overview
Generate user guides, tutorials, and help books from documents using AI, then render the result as a block (HTML or Markdown).

## Features
- **AI Processing**: Automatically convert raw manuals or requirements into structured guides.
- **Multi-format Rendering**: Display output beautifully as Markdown or HTML.
- **Chapter Navigation**: Supports multi-page or sectioned guides with internal table of contents.

## Usage

1. Enable Build Guide and open its manager to create a Space.
2. Add source documents, select the AI service/model, configure the output, and run Build.
3. Add the separate **User Guide** block to a page and select a completed Space to display the published guide.

## Native Workflow execution

The optional `plugin-workflow-build-guide` adapter adds native Workflow execution. It requires the AI, Workflow, Workflow Loop, and Build Guide plugins. Legacy remains the default engine for existing Spaces.

After installing and enabling the adapter, a root administrator can provision the managed graph with `POST /api/workflowBuildGuide:setup`. Check `GET /api/workflowBuildGuide:status`; proceed only when `enabled` is `true` and `blockers` is empty. The graph is managed by the adapter and must not be edited directly.

In the Build Guide manager, edit a Space and select **Workflow** under **Build engine**. The engine selection applies to new runs. Keep the Workflow adapter available while workflow runs are active; drain old runs before provisioning a new revision. See [workflow-build-operations.md](docs/workflow-build-operations.md) for staging, cutover, and rollback steps.
