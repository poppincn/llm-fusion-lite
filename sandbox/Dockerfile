# Era Fusion agentic sandbox — a disposable environment with the subscription
# coding agents + runtimes + MCP preinstalled, so panelists can run as full
# tool-using agents safely (the container, not the host, absorbs any bash/file
# actions). Creds are NEVER baked in — they are mounted read-only at run time.
FROM node:22-bookworm

# Runtimes + tools the agents reach for (python for code-exec, git/rg for repo work).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git ripgrep curl ca-certificates jq \
    && rm -rf /var/lib/apt/lists/*

# The three subscription/agent CLIs + a couple of MCP servers for the shared toolset.
RUN npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      @google/gemini-cli \
      @modelcontextprotocol/server-filesystem \
    && npm cache clean --force

# Shared grounding toolset every panelist reaches via its shell: exact computation
# (scientific Python) + keyless web search + URL fetch. Uniform across providers.
RUN pip3 install --no-cache-dir --break-system-packages \
      numpy scipy sympy mpmath \
      ddgs requests beautifulsoup4 lxml readability-lxml
COPY tools/websearch tools/fetchurl /usr/local/bin/
RUN chmod +x /usr/local/bin/websearch /usr/local/bin/fetchurl

# Non-root agent user; /work holds per-panelist run dirs, /cfg holds mounted config.
RUN useradd -ms /bin/bash agent && mkdir -p /work /cfg && chown -R agent:agent /work /cfg
USER agent
WORKDIR /work
ENV HOME=/home/agent

# Long-lived: the engine `docker exec`s panelist agents into fresh /work/<runid> dirs.
CMD ["sleep", "infinity"]
