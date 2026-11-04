"""GridSnap scores, for personal bests and the weekly, monthly and all-time leaderboards.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "gridsnap_scores",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "player_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("players.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column("lines", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("assisted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("score >= 0", name="score_non_negative"),
    )
    op.create_index("ix_gridsnap_scores_created", "gridsnap_scores", ["created_at"])
    op.create_index("ix_gridsnap_scores_player_score", "gridsnap_scores", ["player_id", "score"])


def downgrade() -> None:
    op.drop_index("ix_gridsnap_scores_player_score", table_name="gridsnap_scores")
    op.drop_index("ix_gridsnap_scores_created", table_name="gridsnap_scores")
    op.drop_table("gridsnap_scores")
