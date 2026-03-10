export function buildPlannerPrompt(contract: string, retryCount: number, failureContext?: string): string {
  let prompt = `You are a software implementation planner. Analyze the task and produce a PRECISE
implementation plan that a coding agent will follow EXACTLY.

## Task
${contract}

## Instructions
1. Read and understand the codebase structure, conventions, and patterns.
2. Identify which files need to be created or modified.
3. Design the implementation approach with step-by-step instructions.
4. Include test criteria — how to verify the implementation is complete.

Output a detailed implementation plan in markdown. Be extremely specific about:
- Exact file paths to create or modify
- Exact function signatures, types, and interfaces
- Exact test commands to run for verification
- Step-by-step order of implementation

Do NOT be vague. The coding agent will follow your plan literally.`;

  if (retryCount > 0 && failureContext) {
    prompt += `

## RETRY — Previous Attempt Failed (attempt ${retryCount})
${failureContext}

Analyze what went wrong. Adjust the plan to avoid the same failure. Do NOT repeat the same approach.`;
  }

  return prompt;
}

export function buildCoderPrompt(contract: string, plannerOutput?: string): string {
  let prompt = `You have the following contract to implement. Follow it EXACTLY.

Do NOT add anything beyond what is specified. Do NOT modify test files.
Implement the code, then run the tests specified in the completion criteria.
Your task is NOT complete until all tests pass.

---
CONTRACT:
${contract}
---`;

  if (plannerOutput) {
    prompt += `

IMPLEMENTATION PLAN (from planner — follow this precisely):
${plannerOutput}`;
  }

  prompt += `

Start by reading the contract carefully, then implement it step by step.
When done, run all verification commands. Fix any failures before finishing.`;

  return prompt;
}

export function buildReviewerPrompt(contract: string, plannerOutput?: string): string {
  return `You are a code reviewer for an automated pipeline. Verify that the implementation
matches the contract EXACTLY and meets quality standards.

## Original Contract
${contract}
${plannerOutput ? `\n## Implementation Plan\n${plannerOutput}` : ""}

## Your Task
1. Read the changes in this worktree (check git diff, read modified files).
2. Verify every item in the contract was implemented.
3. Check for:
   - Missing implementations from the contract
   - Deviations from the specified approach
   - Obvious bugs or logic errors
4. Output your verdict as JSON:

{
  "verdict": "pass" or "fail",
  "summary": "Brief summary of your review",
  "issues": [
    { "severity": "critical" or "major" or "minor", "file": "path", "description": "..." }
  ]
}

A "pass" means the implementation is correct and complete per the contract.
A "fail" means there are critical or major issues that must be fixed.
Minor issues alone should NOT cause a fail.

Output ONLY the JSON verdict. No other commentary.`;
}

export function buildFailureContext(
  checksResults?: Array<{ name: string; passed: boolean; output: string }>,
  reviewOutput?: string,
  agentError?: string,
): string {
  const parts: string[] = [];

  if (checksResults) {
    const failed = checksResults.filter((c) => !c.passed);
    if (failed.length > 0) {
      parts.push("## Failed Checks");
      for (const check of failed) {
        parts.push(`- ${check.name}: ${check.output.slice(0, 500)}`);
      }
    }
  }

  if (reviewOutput) {
    parts.push(`## Reviewer Feedback\n${reviewOutput.slice(0, 1000)}`);
  }

  if (agentError) {
    parts.push(`## Agent Error\n${agentError.slice(0, 500)}`);
  }

  return parts.join("\n\n");
}
