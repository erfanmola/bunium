import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>__PROJECT_NAME__</h1>
      <p>A bunium + React + JavaScript app.</p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        count is {count}
      </button>
    </div>
  );
}
