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
  return `Your task is to review pull requests. Instructions:
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
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
    temperature: 0.2,
    max_completion_tokens: 8000,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    console.log('=== OpenAI Request ===');
    console.log('Model:', OPENAI_API_MODEL);
    console.log('Config:', JSON.stringify(queryConfig, null, 2));
    console.log('Prompt:', prompt);
    
    const response = await openai.beta.chat.completions.parse({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
      response_format: zodResponseFormat(ReviewResponse, "reviews")
    });

    console.log('\n=== OpenAI Response ===');
    console.log('Raw response:', JSON.stringify(response, null, 2));
    console.log('First choice:', response.choices[0]);
    console.log('Message:', response.choices[0].message);
    console.log('Parsed reviews:', response.choices[0].message?.parsed?.reviews);

    const reviews = response.choices[0].message?.parsed?.reviews || null;
    console.log('\n=== Final Reviews ===');
    console.log(JSON.stringify(reviews, null, 2));
    
    return reviews;
  } catch (error) {
    console.error('\n=== OpenAI Error ===');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    if (error.response) {
      console.error('API Response:', JSON.stringify(error.response, null, 2));
    }
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
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
    console.log('\n=== Starting PR Review ===');
    const prDetails = await getPRDetails();
    console.log('PR Details:', JSON.stringify(prDetails, null, 2));

    let diff: string | null;
    const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
    );
    console.log('Event Data:', JSON.stringify(eventData, null, 2));

    if (eventData.action === "opened") {
      console.log('Processing opened PR');
      diff = await getDiff(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
      );
    } else if (eventData.action === "synchronize") {
      console.log('Processing synchronized PR');
      const newBaseSha = eventData.before;
      const newHeadSha = eventData.after;
      console.log('Base SHA:', newBaseSha);
      console.log('Head SHA:', newHeadSha);

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
      console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
      return;
    }

    if (!diff) {
      console.log("No diff found");
      return;
    }

    console.log('\n=== Processing Diff ===');
    console.log('Raw diff:', diff);
    
    const parsedDiff = parseDiff(diff);
    console.log('Parsed diff:', JSON.stringify(parsedDiff, null, 2));

    const excludePatterns = core
      .getInput("exclude")
      .split(",")
      .map((s) => s.trim());
    console.log('Exclude patterns:', excludePatterns);

    const filteredDiff = parsedDiff.filter((file) => {
      const excluded = !excludePatterns.some((pattern) =>
        minimatch(file.to ?? "", pattern)
      );
      console.log(`File ${file.to}: ${excluded ? 'included' : 'excluded'}`);
      return excluded;
    });

    console.log('\n=== Analyzing Code ===');
    const comments = await analyzeCode(filteredDiff, prDetails);
    console.log('Generated comments:', JSON.stringify(comments, null, 2));

    if (comments.length > 0) {
      console.log('\n=== Creating Review ===');
      await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
      );
      console.log('Review created successfully');
    } else {
      console.log('No comments to create');
    }
    
    console.log('\n=== Review Complete ===');
  } catch (error) {
    console.error('\n=== Fatal Error ===');
    console.error('Error type:', error.constructor.name);
    console.error('Error message:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
