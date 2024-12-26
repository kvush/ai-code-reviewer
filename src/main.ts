import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `You are a code reviewer. Your task is to analyze the code and provide feedback in a structured format.

You MUST respond with a JSON object that matches this schema:
{
  "reviews": [
    {
      "lineNumber": "<line_number>",
      "reviewComment": "<review_comment>"
    }
  ]
}

Rules:
- Do not give positive comments or compliments
- If there are no issues to improve, return {"reviews": []}
- Write comments in GitHub Markdown format
- Never suggest adding code comments
- Focus on code quality, security, and best practices

File: ${file.to}
PR Title: ${prDetails.title}
Description: ${prDetails.description}

Code to review:
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}`;
}

// Define the review response schema
const ReviewComment = z.object({
  lineNumber: z.string(),
  reviewComment: z.string()
});

const ReviewResponse = z.object({
  reviews: z.array(ReviewComment)
});

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 1,
    max_tokens: 8000,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    core.info('=== OpenAI Request ===');
    core.info(`Model: ${OPENAI_API_MODEL}`);
    core.debug(`Config: ${JSON.stringify(queryConfig, null, 2)}`);
    core.debug(`Prompt: ${prompt}`);
    
    const response = await openai.beta.chat.completions.parse({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content: "You are a code reviewer that must respond with valid JSON matching the schema.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      response_format: zodResponseFormat(ReviewResponse, "reviews")
    });

    core.debug('\n=== OpenAI Response ===');
    core.debug(`Raw response: ${JSON.stringify(response, null, 2)}`);
    core.debug(`First choice: ${JSON.stringify(response.choices[0])}`);
    core.debug(`Message: ${JSON.stringify(response.choices[0].message)}`);
    core.info(`Parsed reviews: ${JSON.stringify(response.choices[0].message?.parsed?.reviews, null, 2)}`);

    const reviews = response.choices[0].message?.parsed?.reviews || null;
    core.info('\n=== Final Reviews ===');
    core.info(JSON.stringify(reviews, null, 2));
    
    return reviews;
  } catch (error) {
    core.error('\n=== OpenAI Error ===');
    core.error(`Error: ${error}`);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  try {
    core.info('\n=== Starting PR Review ===');
    const prDetails = await getPRDetails();
    core.info(`PR Details: ${JSON.stringify(prDetails, null, 2)}`);

    let diff: string | null;
    const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
    );
    core.debug(`Event Data: ${JSON.stringify(eventData, null, 2)}`);

    if (eventData.action === "opened") {
      core.info('Processing opened PR');
      diff = await getDiff(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
      );
    } else if (eventData.action === "synchronize") {
      core.info('Processing synchronized PR');
      const newBaseSha = eventData.before;
      const newHeadSha = eventData.after;
      core.debug(`Base SHA: ${newBaseSha}`);
      core.debug(`Head SHA: ${newHeadSha}`);

      const response = await octokit.repos.compareCommits({
        headers: {
          accept: "application/vnd.github.v3.diff",
        },
        owner: prDetails.owner,
        repo: prDetails.repo,
        base: newBaseSha,
        head: newHeadSha,
      });

      diff = String(response.data);
    } else {
      core.warning(`Unsupported event: ${process.env.GITHUB_EVENT_NAME}`);
      return;
    }

    if (!diff) {
      core.warning("No diff found");
      return;
    }

    core.debug('\n=== Processing Diff ===');
    core.debug(`Raw diff: ${diff}`);
    
    const parsedDiff = parseDiff(diff);
    core.debug(`Parsed diff: ${JSON.stringify(parsedDiff, null, 2)}`);

    const excludePatterns = core
      .getInput("exclude")
      .split(",")
      .map((s) => s.trim());
    core.info(`Exclude patterns: ${excludePatterns.join(', ')}`);

    const filteredDiff = parsedDiff.filter((file) => {
      const excluded = !excludePatterns.some((pattern) =>
        minimatch(file.to ?? "", pattern)
      );
      core.debug(`File ${file.to}: ${excluded ? 'included' : 'excluded'}`);
      return excluded;
    });

    core.info('\n=== Analyzing Code ===');
    const comments = await analyzeCode(filteredDiff, prDetails);
    core.info(`Generated comments: ${JSON.stringify(comments, null, 2)}`);

    if (comments.length > 0) {
      core.info('\n=== Creating Review ===');
      await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
      );
      core.info('Review created successfully');
    } else {
      core.info('No comments to create');
    }
    
    core.info('\n=== Review Complete ===');
  } catch (error) {
    core.setFailed(`Error: ${error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
