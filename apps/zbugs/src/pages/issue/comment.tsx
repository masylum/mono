import {useQuery} from '@rocicorp/zero/react';
import {useState} from 'react';
import {Button} from '../../components/button.js';
import Markdown from '../../components/markdown.js';
import RelativeTime from '../../components/relative-time.js';
import {useLogin} from '../../hooks/use-login.js';
import {useZero} from '../../hooks/use-zero.js';
import CommentComposer from './comment-composer.js';
import style from './comment.module.css';

export default function Comment({id, issueID}: {id: string; issueID: string}) {
  const z = useZero();
  const q = z.query.comment
    .where('id', id)
    .related('creator', creator => creator.one())
    .one();
  const comment = useQuery(q);
  const [editing, setEditing] = useState(false);
  const login = useLogin();

  if (!comment) {
    return null;
  }

  const edit = () => setEditing(true);
  const remove = () => z.mutate.comment.delete({id});

  return (
    <div
      className={`${style.commentItem} ${
        comment.creatorID == login.loginState?.decoded.sub
          ? style.authorComment
          : ''
      }`}
    >
      <p className={style.commentAuthor}>
        <img
          src={comment.creator?.avatar}
          style={{
            width: '2rem',
            height: '2rem',
            borderRadius: '50%',
            display: 'inline-block',
            marginRight: '0.3rem',
          }}
          alt={comment.creator?.name}
        />{' '}
        {comment.creator?.login}
      </p>
      <span className={style.commentTimestamp}>
        <RelativeTime created={comment.created} />
      </span>
      {editing ? (
        <CommentComposer
          id={id}
          body={comment.body}
          issueID={issueID}
          onDone={() => setEditing(false)}
        />
      ) : (
        <div className="markdown-container">
          <Markdown>{comment.body}</Markdown>
        </div>
      )}
      {editing || comment.creatorID !== login.loginState?.decoded.sub ? null : (
        <div className={style.commentActions}>
          <Button onAction={edit}>Edit</Button>
          <Button onAction={remove}>Delete</Button>
        </div>
      )}
    </div>
  );
}
