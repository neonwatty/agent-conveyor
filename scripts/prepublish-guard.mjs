if (process.env.AGENT_CONVEYOR_ALLOW_NPM_PUBLISH !== "1") {
  console.error(
    "Refusing npm publish until the TypeScript migration final audit explicitly approves it.",
  );
  console.error("Set AGENT_CONVEYOR_ALLOW_NPM_PUBLISH=1 only for an approved release run.");
  process.exit(1);
}
