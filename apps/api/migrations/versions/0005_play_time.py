"""Play time on finished games, so play_events can answer "how long do people play".

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Seconds from the start of a level (or run) to its clear, loss or end; null on
    # events that don't finish a game. Server-measured: the client can't inflate it.
    op.add_column("play_events", sa.Column("seconds", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("play_events", "seconds")
