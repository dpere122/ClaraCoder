"""Tiny stdio MCP server used by the host adapter test."""

from mcp.server.fastmcp import FastMCP

app = FastMCP('clara-mcp-fixture')


@app.tool()
def ping(text: str) -> str:
    """Return pong plus the text."""
    return f'pong:{text}'


if __name__ == '__main__':
    app.run(transport='stdio')
