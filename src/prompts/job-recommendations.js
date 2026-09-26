import { z } from 'zod';

/**
 * Job Recommendations Schema - Parameters for job recommendations
 */
export const jobRecommendationsSchema = z.object({
  skills: z.string()
    .describe('A list of skills the job seeker possesses'),
  experienceLevel: z.string()
    .describe('The experience level of the job seeker (e.g., entry-level, mid-level, senior)'),
  preferredLocation: z.string()
    .describe('The preferred location for jobs (can be remote, hybrid, or specific locations)'),
  jobSeekerInterests: z.string()
    .describe('Areas of interest for the job seeker that can help guide job recommendations'),
  jobType: z.string()
    .describe('The type of job the seeker is looking for (e.g., full-time, part-time, contract, internship)'),
});


/**
 * Complete job recommendations prompt definition for MCP server
 */
export const jobRecommendationsPrompt = (server) => server.prompt(
  'job_recommendations',
  'Get personalized job recommendations based on skills and preferences',
  // `.shape`, not the wrapped schema — see the note in prompts/search-jobs.js.
  jobRecommendationsSchema.shape,
  (inputs) => {
    return {
      messages: [
        {
          role: 'system',
          content: `
You are a career advisor specializing in helping job seekers find relevant job opportunities based on their skills and preferences.
Given the information about a job seeker and a list of job postings, recommend the most suitable jobs for them.

For each recommended job, explain why it's a good match based on the person's skills, experience level, and interests.
Focus on highlighting the alignment between the job requirements and the candidate's profile.

Keep in mind that the job recommendations should be practical and actionable, allowing the job seeker to apply for roles where they have a good chance of success.
`,
        },
        {
          role: 'user',
          content: `
Job Seeker Profile:
- Skills: ${inputs.skills}
- Experience Level: ${inputs.experienceLevel}
- Preferred Location: ${inputs.preferredLocation}
- Areas of Interest: ${inputs.jobSeekerInterests}
- Job Type Preference: ${inputs.jobType}

Please recommend relevant job opportunities from the list below, explaining why each job would be a good match:

{{jobListings}}
        `,
        },
      ],
    };
  },
);
