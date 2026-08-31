const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// runLocally removed for self-hosted Judge0

// Self-hosted Judge0 Configuration
const JUDGE0_API_URL = 'https://compiler.skillmedha.com/submissions';
const JUDGE0_API_KEY = process.env.JUDGE0_API_KEY || ''; // Optional: Only if you secured your self-hosted instance

const LANGUAGE_MAP = {
  'javascript': 93,
  'python': 71,
  'python3': 71,
  'java': 62,
  'cpp': 54,
  'c': 50
};

// Generates driver code for languages where users just write a function
function generateDriverCode(language, code, inputStr) {
  // If the user already wrote a main function, don't wrap it.
  if (code.includes('function main()') || code.includes('public static void main') || code.includes('int main(') || code.includes('if __name__ == "__main__"')) {
    return code;
  }

  // Parse the input string into arguments (assuming JSON-like comma separated values)
  // Example: "[2,7,11,15], 9" -> args = [[2,7,11,15], 9]
  
  if (language === 'javascript') {
    // Regex to find the first declared function name
    const funcMatch = code.match(/(?:var|let|const|function)\s+([a-zA-Z0-9_]+)\s*=?\s*(?:function|\()/);
    const funcName = funcMatch ? funcMatch[1] : null;
    
    if (funcName) {
      return `
${code}

// --- Auto-Generated Driver Code ---
try {
  const inputArgs = [${inputStr}];
  const result = ${funcName}(...inputArgs);
  if (typeof result === 'object') {
    console.log(JSON.stringify(result));
  } else {
    console.log(result);
  }
} catch (e) {
  console.error("Driver Error:", e.message);
}
`;
    }
  }

  if (language === 'python' || language === 'python3') {
    return `
import json
${code}

# --- Auto-Generated Driver Code ---
if __name__ == "__main__":
    import inspect
    # Find the last defined function in the user's code
    functions = [f for f in locals().values() if inspect.isfunction(f)]
    if functions:
        user_func = functions[-1]
        args = [${inputStr}]
        res = user_func(*args)
        if isinstance(res, (list, dict)):
            print(json.dumps(res, separators=(',', ':')))
        else:
            print(res)
`;
  }

  // For C, C++, Java without a main function, we just return the code and rely on Judge0 to fail,
  // or we expect the user to write their own main function for now.
  // Advanced type-aware driver generation for statically typed languages requires problem metadata.
  return code;
}

module.exports.runCode = async (req, res) => {
  try {
    const { code, language, testCases } = req.body;
    
    if (!code || !language || !testCases || !Array.isArray(testCases)) {
      return res.status(400).json({ err: "Missing required fields" });
    }

    const languageId = LANGUAGE_MAP[language.toLowerCase()];
    if (!languageId) {
      return res.status(400).json({ err: `Language ${language} not supported yet.` });
    }

    // Prepare batch requests for Judge0
    const submissions = testCases.map(tc => {
      const finalCode = generateDriverCode(language, code, tc.input);
      return {
        language_id: languageId,
        source_code: finalCode,
        stdin: tc.input // Pass stdin just in case they wrote a standard CP program
      };
    });

    // 1. Create batch submission
    const createRes = await axios.post(
      `${JUDGE0_API_URL}/batch?base64_encoded=false`,
      { submissions },
      {
        headers: {
          'content-type': 'application/json'
        }
      }
    );

    const tokens = createRes.data.map(t => t.token).join(',');

    // 2. Poll for results (Judge0 takes a second to process)
    let results = [];
    let attempts = 0;
    while (attempts < 5) {
      await new Promise(r => setTimeout(r, 1000)); // wait 1s
      
      const getRes = await axios.get(
        `${JUDGE0_API_URL}/batch?tokens=${tokens}&base64_encoded=false&fields=stdout,stderr,status_id,compile_output`
      );
      
      results = getRes.data.submissions;
      
      // Check if all are done (status_id <= 2 means In Queue or Processing)
      if (results.every(r => r.status_id > 2)) {
        break;
      }
      attempts++;
    }

    // 3. Map results back
    const mappedResults = testCases.map((tc, idx) => {
      const judgeRes = results[idx] || {};
      const actualOutput = (judgeRes.stdout || judgeRes.compile_output || judgeRes.stderr || "").trim();
      const expectedOutput = (tc.output || tc.expectedOutput || "").trim();
      
      // Basic string comparison (remove all whitespaces for forgiving match)
      const passed = judgeRes.status_id === 3 && actualOutput.replace(/\s+/g, '') === expectedOutput.replace(/\s+/g, '');
      
      return {
        input: tc.isHidden ? "Hidden Test Case" : tc.input,
        expected: tc.isHidden ? "Hidden" : expectedOutput,
        output: tc.isHidden ? "Hidden" : actualOutput,
        passed,
        isHidden: tc.isHidden,
        status: judgeRes.status_id === 3 ? (passed ? "Accepted" : "Wrong Answer") : "Runtime Error"
      };
    });

    const allPassed = mappedResults.every(r => r.passed);

    res.status(200).json({
      status: allPassed ? "Accepted" : "Wrong Answer",
      cases: mappedResults
    });

  } catch (error) {
    console.error("Compiler Error:", error?.response?.data || error.message);
    res.status(500).json({ err: "Failed to execute code" });
  }
};
